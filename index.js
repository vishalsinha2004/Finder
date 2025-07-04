const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const marked = require('marked');

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true
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

// Routes
app.get('/', function(req, res) {
    fs.readdir(`./files`, function(err, files) {
        res.render("index", { files: files });
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
        // For PDF or image files
        res.render('show', {
            filename: filename,
            isPdf: isPdf,
            isImage: isImage,
            filedata: null
        });
    } else {
        // For text files
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
    res.sendFile(filePath);
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
    fs.rename(`./files/${req.body.previous}`, `./files/${req.body.new}`, function(err) {
        if (err) return res.status(500).send('Error renaming file');
        res.redirect("/");
    });
});

app.post('/create', function(req, res) {
    const filename = req.body.title.split(' ').join('') + '.txt';
    fs.writeFile(`./files/${filename}`, req.body.details, function(err) {
        if (err) return res.status(500).send('Error creating file');
        res.redirect("/");
    });
});

app.listen(3000, () => {
    console.log('Server running on port 3000'); 
});