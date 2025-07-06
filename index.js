const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const marked = require('marked');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true
});

// Configure file upload storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Create files directory if it doesn't exist
    if (!fs.existsSync('./files')) {
      fs.mkdirSync('./files');
    }
    cb(null, './files/');
  },
  filename: function (req, file, cb) {
    // Sanitize filename and add unique prefix
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${uuidv4()}_${sanitizedName}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5 // Max 5 files at once
  },
  fileFilter: (req, file, cb) => {
    // Accept all file types but you could filter here
    cb(null, true);
  }
});

// Set up Express
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Make marked available to all templates
app.locals.marked = marked;

// Supported image extensions
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

// File upload endpoint
app.post('/upload', upload.array('files'), function(req, res) {
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

// Delete file endpoint
app.delete('/file/:filename', function(req, res) {
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

// Routes
app.get('/', function(req, res) {
  fs.readdir(`./files`, function(err, files) {
    if (err) {
      console.error('Error reading files:', err);
      // If directory doesn't exist, create it and return empty array
      if (err.code === 'ENOENT') {
        fs.mkdirSync('./files');
        return res.render("index", { files: [] });
      }
      return res.status(500).send('Error reading files');
    }
    
    // Sort files by creation time (newest first)
    const sortedFiles = files.map(file => {
      const stat = fs.statSync(path.join(__dirname, 'files', file));
      return {
        name: file,
        createdAt: stat.birthtime
      };
    }).sort((a, b) => b.createdAt - a.createdAt)
      .map(file => file.name);
    
    res.render("index", { files: sortedFiles });
  });
});

app.get('/file/:filename', function(req, res) {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'files', filename);
  const ext = path.extname(filename).toLowerCase();
  
  // Check file types
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
    fs.readFile(filePath, "utf-8", function(err, filedata) {
      if (err) return res.status(404).send('File not found');
      
      // Check if file is markdown
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

// Route to serve actual files
app.get('/files/:filename', function(req, res) {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'files', filename);
  
  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.status(404).send('File not found');
    }
    res.sendFile(filePath);
  });
});

app.get('/edit/:filename', function(req, res) {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'files', filename);
  
  fs.readFile(filePath, "utf-8", function(err, filedata) {
    if (err) return res.status(404).send('File not found');
    res.render('edit', { 
      filename: filename,
      filedata: filedata 
    });
  });
});

app.post('/edit', function(req, res) {
  const oldPath = path.join(__dirname, 'files', req.body.previous);
  const newPath = path.join(__dirname, 'files', req.body.new);
  
  fs.rename(oldPath, newPath, function(err) {
    if (err) {
      console.error('Error renaming file:', err);
      return res.status(500).send('Error renaming file');
    }
    res.redirect("/");
  });
});

app.post('/create', function(req, res) {
  if (!req.body.title || !req.body.details) {
    return res.status(400).send('Title and details are required');
  }
  
  // Sanitize filename
  const filename = req.body.title.replace(/[^a-zA-Z0-9]/g, '_') + '.txt';
  const filePath = path.join(__dirname, 'files', filename);
  
  fs.writeFile(filePath, req.body.details, function(err) {
    if (err) {
      console.error('Error creating file:', err);
      return res.status(500).send('Error creating file');
    }
    res.redirect("/");
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`); 
});