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
    const uploadPath = './files';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath);
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

app.get('/', function (req, res) {
  fs.readdir('./files', function (err, files) {
    if (err) {
      console.error('Error reading files:', err);
      if (err.code === 'ENOENT') {
        fs.mkdirSync('./files');
        // This line is updated to pass the user object
        return res.render("index", { files: [], user: req.user });
      }
      return res.status(500).send('Error reading files');
    }

    const sortedFiles = files.map(file => {
      const stat = fs.statSync(path.join(__dirname, 'files', file));
      return {
        name: file,
        createdAt: stat.birthtime
      };
    }).sort((a, b) => b.createdAt - a.createdAt)
      .map(file => file.name);

    // This line is also updated to pass the user object
    res.render("index", { files: sortedFiles, user: req.user });
  });
});

app.post('/upload', upload.array('files'), function (req, res) {
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

app.delete('/file/:filename', function (req, res) {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'files', filename);

  fs.unlink(filePath, (err) => {
    if (err) {
      console.error('Delete error:', err);
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
});

app.get('/file/:filename', function (req, res) {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'files', filename);
  const ext = path.extname(filename).toLowerCase();
  const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const isPdf = ext === '.pdf';
  const isImage = IMAGE_EXTENSIONS.includes(ext);

  if (isPdf || isImage) {
    res.render('show', {
      filename: filename,
      isPdf: isPdf,
      isImage: isImage,
      filedata: null
    });
  } else {
    fs.readFile(filePath, "utf-8", function (err, filedata) {
      if (err) return res.status(404).send('File not found');
      const isMarkdown = ext === '.md';
      res.render('show', {
        filename: filename,
        filedata: isMarkdown ? marked(filedata) : filedata,
        isPdf: false,
        isImage: false,
        isMarkdown: isMarkdown
      });
    });
  }
});

app.get('/files/:filename', function (req, res) {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'files', filename);

  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.status(404).send('File not found');
    }
    res.sendFile(filePath);
  });
});

app.get('/edit/:filename', function (req, res) {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'files', filename);

  fs.readFile(filePath, "utf-8", function (err, filedata) {
    if (err) return res.status(404).send('File not found');
    res.render('edit', {
      filename: filename,
      filedata: filedata
    });
  });
});

app.get('/settings', function(req, res) {
  res.render("settings");
});

app.post('/edit', function (req, res) {
  const oldPath = path.join(__dirname, 'files', req.body.previous);
  const newPath = path.join(__dirname, 'files', req.body.new);

  fs.rename(oldPath, newPath, function (err) {
    if (err) {
      console.error('Error renaming file:', err);
      return res.status(500).send('Error renaming file');
    }
    res.redirect("/");
  });
});

app.post('/create', function (req, res) {
  if (!req.body.title || !req.body.details) {
    return res.status(400).send('Title and details are required');
  }

  const filename = req.body.title.replace(/[^a-zA-Z0-9]/g, '_') + '.txt';
  const filePath = path.join(__dirname, 'files', filename);

  fs.writeFile(filePath, req.body.details, function (err) {
    if (err) {
      console.error('Error creating file:', err);
      return res.status(500).send('Error creating file');
    }
    res.redirect("/");
  });
});

// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});