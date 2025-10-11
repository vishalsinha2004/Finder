// This MUST be the first line to load the .env file
require('dotenv').config();

const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const marked = require('marked');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const cookieParser = require('cookie-parser');

// --- Secure Firebase Admin SDK Initialization ---
try {
  let serviceAccount;

  // This will check for the variable in your .env file (locally) or Netlify settings (deployed)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    console.log('Initializing Firebase Admin from environment variable...');
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  } else {
    // This is a fallback in case the environment variable is not found
    console.error('CRITICAL: FIREBASE_SERVICE_ACCOUNT_KEY environment variable not found.');
    console.log('Attempting to fall back to local serviceAccountKey.json file...');
    serviceAccount = require('./serviceAccountKey.json'); // This will now fail if .env is missing
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully.');

} catch (error) {
  console.error('CRITICAL: Firebase Admin SDK initialization failed!', error);
  process.exit(1); // Exit if Firebase can't connect
}

// --- Middleware Configurations ---
marked.setOptions({
  breaks: true,
  gfm: true
});

// Configure file upload storage with Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const semester = req.body.semester || '';
    const folder = req.params.folder || '';
    const uploadPath = path.join('./files', semester, folder);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '');
    cb(null, `${uuidv4()}_${sanitizedName}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5 // Max 5 files at once
  }
});

// --- Express App Setup ---
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

// Make 'marked' available to all EJS templates
app.locals.marked = marked;

// --- Authentication Middleware ---
const checkAuth = (req, res, next) => {
  const sessionCookie = req.cookies.session || '';

  admin
    .auth()
    .verifySessionCookie(sessionCookie, true /** checkRevoked */)
    .then((decodedClaims) => {
      req.user = decodedClaims; // Make user info available in the request
      next();
    })
    .catch((error) => {
      // Session cookie is invalid, redirect to login.
      res.redirect("/login");
    });
};

// --- Public Routes (No Authentication Required) ---
app.get('/login', (req, res) => {
  res.render('login');
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

// This route creates the session cookie after client-side login
app.post('/sessionLogin', async (req, res) => {
    const idToken = req.body.idToken.toString();
    const expiresIn = 60 * 60 * 24 * 5 * 1000; // 5 days

    try {
        const sessionCookie = await admin.auth().createSessionCookie(idToken, { expiresIn });
        const options = { maxAge: expiresIn, httpOnly: true, secure: process.env.NODE_ENV === 'production' };
        res.cookie('session', sessionCookie, options);
        res.end(JSON.stringify({ status: 'success' }));
    } catch (error) {
        console.error('Error creating session cookie:', error);
        res.status(401).send({
            error: 'Unauthorized request',
            code: error.code || 'UNKNOWN_ERROR'
        });
    }
});

// Logout route to clear the session cookie
app.get('/logout', (req, res) => {
    res.clearCookie('session');
    res.redirect('/login');
});

// --- Protected Routes (Authentication Required) ---
// The checkAuth middleware is applied to all routes defined below this line.
app.use(checkAuth);

// *** THE FIX IS IN THIS FUNCTION ***
const readDirectory = (dirPath, currentFolder = null) => {
  return new Promise((resolve, reject) => {
    fs.readdir(dirPath, (err, files) => {
      if (err) {
        if (err.code === 'ENOENT') {
          fs.mkdirSync(dirPath, { recursive: true });
          return resolve([]);
        }
        return reject(err);
      }

      const fileDetails = files
        .filter(file => file.toLowerCase() !== 'images') // <<< FIX: This line ignores the 'images' folder
        .map(file => {
          const filePath = path.join(dirPath, file);
          const stat = fs.statSync(filePath);
          return {
            name: file,
            isDirectory: stat.isDirectory(),
            createdAt: stat.birthtime,
            path: currentFolder ? path.join(currentFolder, file) : file
          };
        }).sort((a, b) => {
          // Sort directories first, then by creation date
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return b.createdAt - a.createdAt;
        });

      resolve(fileDetails);
    });
  });
};

app.get('/', function (req, res) {
  const filesPath = path.join(__dirname, 'files');
  
  readDirectory(filesPath)
    .then(files => {
      res.render("index", { 
        files: files, 
        user: req.user, 
        currentFolder: null 
      });
    })
    .catch(err => {
      console.error('Error reading files:', err);
      res.status(500).send('Error reading files');
    });
});

app.get('/folder/*', function (req, res) {
  const folderPath = req.params[0]; // Get the entire folder path
  const fullPath = path.join(__dirname, 'files', folderPath);

  // Security check to prevent directory traversal
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(path.join(__dirname, 'files'))) {
    return res.status(400).send('Invalid folder path');
  }

  readDirectory(fullPath, folderPath)
    .then(files => {
      res.render("index", { 
        files: files, 
        user: req.user, 
        currentFolder: folderPath 
      });
    })
    .catch(err => {
      console.error('Error reading folder:', err);
      if (err.code === 'ENOENT') {
        return res.status(404).send('Folder not found');
      }
      res.status(500).send('Error reading folder');
    });
});

app.post('/upload/*', upload.array('files'), function (req, res) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files were uploaded.'
      });
    }

    const uploadedFiles = req.files.map(file => file.filename);
    res.status(200).json({
      success: true,
      message: 'Files uploaded successfully',
      files: uploadedFiles
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Error uploading files'
    });
  }
});

app.delete('/file/*', function (req, res) {
  const filePath = req.params[0]; // Get the entire file path including folders
  const fullPath = path.join(__dirname, 'files', filePath);

  // Security check
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(path.join(__dirname, 'files'))) {
    return res.status(400).json({
      success: false,
      message: 'Invalid file path'
    });
  }

  // Check if path exists
  fs.stat(fullPath, (statErr, stats) => {
    if (statErr) {
      if (statErr.code === 'ENOENT') {
        return res.status(404).json({
          success: false,
          message: 'File or folder not found'
        });
      }
      return res.status(500).json({
        success: false,
        message: 'Error accessing path'
      });
    }

    // Delete based on type (file vs directory)
    if (stats.isDirectory()) {
      // Delete directory recursively
      fs.rm(fullPath, { recursive: true, force: true }, (dirErr) => {
        if (dirErr) {
          console.error('Delete directory error:', dirErr);
          return res.status(500).json({
            success: false,
            message: 'Error deleting directory'
          });
        }
        res.status(200).json({
          success: true,
          message: 'Directory deleted successfully'
        });
      });
    } else {
      // Delete file
      fs.unlink(fullPath, (fileErr) => {
        if (fileErr) {
          console.error('Delete file error:', fileErr);
          if (fileErr.code === 'ENOENT') {
            return res.status(404).json({
              success: false,
              message: 'File not found'
            });
          }
          return res.status(500).json({
            success: false,
            message: 'Error deleting file'
          });
        }
        res.status(200).json({
          success: true,
          message: 'File deleted successfully'
        });
      });
    }
  });
});

app.get('/file/*', function (req, res) {
  const filePath = req.params[0];
  const fullPath = path.join(__dirname, 'files', filePath);
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const isPdf = ext === '.pdf';
  const isImage = IMAGE_EXTENSIONS.includes(ext);

  // Security check
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(path.join(__dirname, 'files'))) {
    return res.status(400).send('Invalid file path');
  }

  fs.stat(fullPath, (statErr, stats) => {
    if (statErr) {
        if (statErr.code === 'ENOENT') {
            return res.status(404).send('File not found');
        }
        return res.status(500).send('Error accessing file');
    }

    if (stats.isDirectory()) {
        return res.redirect(`/folder/${filePath}`);
    }

    if (isPdf || isImage) {
        res.render('show', {
            filename: filename,
            filePath: filePath, // Pass the full path for serving
            isPdf: isPdf,
            isImage: isImage,
            filedata: null
        });
    } else {
        fs.readFile(fullPath, "utf-8", function (err, filedata) {
            if (err) {
                console.error(`Error reading file: ${fullPath}`, err); // Detailed logging
                if (err.code === 'ENOENT') {
                    return res.status(404).send('File not found');
                }
                return res.status(500).send(`Error reading file: ${err.message}`); // Send more specific error
            }
            const isMarkdown = ext === '.md';
            res.render('show', {
                filename: filename,
                filePath: filePath, // Pass the full path for serving
                filedata: isMarkdown ? marked(filedata) : filedata,
                isPdf: false,
                isImage: false,
                isMarkdown: isMarkdown
            });
        });
    }
  });
});

app.get('/files/*', function (req, res) {
  const filePath = req.params[0];
  const fullPath = path.join(__dirname, 'files', filePath);

  // Security check
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(path.join(__dirname, 'files'))) {
    return res.status(400).send('Invalid file path');
  }

  fs.access(fullPath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.status(404).send('File not found');
    }
    res.sendFile(fullPath);
  });
});

app.get('/edit/*', function (req, res) {
  const filePath = req.params[0];
  const fullPath = path.join(__dirname, 'files', filePath);
  const filename = path.basename(filePath);

  // Security check
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(path.join(__dirname, 'files'))) {
    return res.status(400).send('Invalid file path');
  }

  fs.readFile(fullPath, "utf-8", function (err, filedata) {
    if (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).send('File not found');
      }
      return res.status(500).send('Error reading file');
    }
    res.render('edit', {
      filename: filename,
      filePath: filePath, // Pass full path for form submission
      filedata: filedata
    });
  });
});

app.get('/settings', function(req, res) {
  res.render("settings");
});

app.get('/Dashboard', function (req, res) {
  const filesPath = path.join(__dirname, 'files');
  readDirectory(filesPath)
    .then(files => {
      res.render("Dashboard", {
        files: files,
        user: req.user,
        currentFolder: null
      });
    })
    .catch(err => {
      console.error('Error reading files for dashboard:', err);
      res.status(500).send('Error loading dashboard');
    });
});

app.post('/edit', function (req, res) {
  const oldFilePath = req.body.previousPath || req.body.previous;
  const newFilename = req.body.new.replace(/[^a-zA-Z0-9._-]/g, '_');
  
  // Get the original file extension from the current filename
  const originalExt = path.extname(oldFilePath);
  
  // If user didn't specify an extension in the new filename, keep the original extension
  const hasExtension = newFilename.includes('.');
  const finalNewFilename = hasExtension ? newFilename : newFilename + originalExt;
  
  const oldPath = path.join(__dirname, 'files', oldFilePath);
  const newPath = path.join(__dirname, 'files', path.dirname(oldFilePath), finalNewFilename);

  // Security checks
  const normalizedOldPath = path.normalize(oldPath);
  const normalizedNewPath = path.normalize(newPath);
  if (!normalizedOldPath.startsWith(path.join(__dirname, 'files')) || 
      !normalizedNewPath.startsWith(path.join(__dirname, 'files'))) {
    return res.status(400).send('Invalid file path');
  }

  console.log('Attempting to rename:', {
    oldPath: oldPath,
    newPath: newPath,
    oldFilePath: oldFilePath,
    newFilename: finalNewFilename,
    originalExt: originalExt
  });

  // Check if source file exists BEFORE any processing
  fs.access(oldPath, fs.constants.F_OK, (accessErr) => {
    if (accessErr) {
      console.error('Source file not found:', {
        path: oldPath,
        error: accessErr
      });
      return res.status(404).send(`Source file not found: ${path.basename(oldFilePath)}`);
    }

    // Check if target file already exists
    fs.access(newPath, fs.constants.F_OK, (targetAccessErr) => {
      if (!targetAccessErr) {
        return res.status(409).send(`A file with name "${finalNewFilename}" already exists`);
      }

      // Perform the rename operation
      fs.rename(oldPath, newPath, function (err) {
        if (err) {
          console.error('Error renaming file:', {
            oldPath: oldPath,
            newPath: newPath,
            error: err
          });
          
          if (err.code === 'ENOENT') {
            return res.status(404).send('File not found during rename operation');
          } else if (err.code === 'EACCES') {
            return res.status(403).send('Permission denied');
          } else if (err.code === 'EBUSY') {
            return res.status(409).send('File is busy or in use');
          }
          
          return res.status(500).send('Error renaming file');
        }
        
        console.log('File successfully renamed:', {
          from: path.basename(oldPath),
          to: path.basename(newPath)
        });
        
        // Redirect back to the appropriate folder
        const folderPath = path.dirname(oldFilePath);
        if (folderPath && folderPath !== '.') {
          res.redirect(`/folder/${folderPath}`);
        } else {
          res.redirect("/");
        }
      });
    });
  });
});

app.post('/create', function (req, res) {
  if (!req.body.title || !req.body.details) {
    return res.status(400).send('Title and details are required');
  }

  const filename = req.body.title.replace(/[^a-zA-Z0-9._-]/g, '_') + '.txt';
  const semester = req.body.semester || '';
  const folderPath = req.body.currentFolder || '';
  const filePath = path.join(__dirname, 'files', semester, folderPath, filename);

  // Security check
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(path.join(__dirname, 'files'))) {
    return res.status(400).send('Invalid path');
  }

  // Ensure directory exists
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  fs.writeFile(filePath, req.body.details, function (err) {
    if (err) {
      console.error('Error creating file:', err);
      return res.status(500).send('Error creating file');
    }
    
    if (folderPath) {
      res.redirect(`/folder/${path.join(semester, folderPath)}`);
    } else if (semester) {
      res.redirect(`/folder/${semester}`);
    } else {
      res.redirect("/");
    }
  });
});

app.post('/create-folder', function (req, res) {
  if (!req.body.foldername) {
    return res.status(400).send('Folder name is required');
  }

  const foldername = req.body.foldername.replace(/[^a-zA-Z0-9._-]/g, '_');
  const semester = req.body.semester || '';
  const parentFolder = req.body.currentFolder || '';
  const folderPath = path.join(__dirname, 'files', semester, parentFolder, foldername);

  // Security check
  const normalizedPath = path.normalize(folderPath);
  if (!normalizedPath.startsWith(path.join(__dirname, 'files'))) {
    return res.status(400).send('Invalid folder path');
  }

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    
    if (parentFolder) {
      res.redirect(`/folder/${path.join(semester, parentFolder)}`);
    } else if (semester) {
        res.redirect(`/folder/${semester}`);
    } else {
      res.redirect("/");
    }
  } else {
    res.status(400).send('Folder already exists');
  }
});

app.post('/create-semester', function (req, res) {
    if (!req.body.semestername) {
        return res.status(400).send('Semester name is required');
    }

    const semestername = req.body.semestername.replace(/[^a-zA-Z0-9._-]/g, '_');
    const folderPath = path.join(__dirname, 'files', semestername);

    // Security check
    const normalizedPath = path.normalize(folderPath);
    if (!normalizedPath.startsWith(path.join(__dirname, 'files'))) {
        return res.status(400).send('Invalid folder path');
    }

    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
        res.redirect("/Dashboard");
    } else {
        res.status(400).send('Semester folder already exists');
    }
});

// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});