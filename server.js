const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

const readDB = () => {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
};

const writeDB = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
};

const broadcastUpdate = () => {
    const db = readDB();
    io.emit('dataUpdate', db.appData);
};

// --- API Endpoints ---

app.post('/api/upload', upload.single('image'), (req, res) => {
    if (req.file) {
        res.json({ success: true, url: `/uploads/${req.file.filename}` });
    } else {
        res.status(400).json({ success: false });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.user === username && u.pass === password);
    if (user) res.json({ success: true, user });
    else res.status(401).json({ success: false, message: "Login yoki parol noto'g'ri!" });
});

app.get('/api/data', (req, res) => {
    const db = readDB();
    const safeUsers = db.users.map(({ pass, ...u }) => u);
    // Return appData and full users list for admin (logic already handled in app.js via isAdmin check or full users returned)
    res.json({ ...db.appData, users: db.users });
});

app.post('/api/visitor', (req, res) => {
    const db = readDB();
    db.appData.visitors = (db.appData.visitors || 0) + 1;
    writeDB(db);
    broadcastUpdate();
    res.json({ success: true, visitors: db.appData.visitors });
});

// NEWS
app.post('/api/news', (req, res) => {
    const db = readDB();
    const newNews = { ...req.body, views: 0 }; // Initialize views
    db.appData.news.unshift(newNews);
    if (db.appData.news.length > 3) db.appData.news = db.appData.news.slice(0, 3);
    writeDB(db);
    broadcastUpdate();
    res.json({ success: true });
});

app.post('/api/news/:id/view', (req, res) => {
    const db = readDB();
    const newsItem = db.appData.news.find(n => n.id == req.params.id);
    if (newsItem) {
        newsItem.views = (newsItem.views || 0) + 1;
        writeDB(db);
        broadcastUpdate();
        res.json({ success: true, views: newsItem.views });
    } else res.status(404).json({ success: false });
});

app.delete('/api/news/:id', (req, res) => {
    const db = readDB();
    db.appData.news = db.appData.news.filter(n => n.id != req.params.id);
    writeDB(db);
    broadcastUpdate();
    res.json({ success: true });
});

// QUESTIONS
app.post('/api/questions', (req, res) => {
    const { subjectId, question } = req.body;
    const db = readDB();
    const subject = db.appData.subjects.find(s => s.id === subjectId);
    if (subject) {
        subject.questions.push(question);
        writeDB(db);
        broadcastUpdate();
        res.json({ success: true });
    } else res.status(404).json({ success: false });
});

app.delete('/api/questions/:subjectId/:index', (req, res) => {
    const db = readDB();
    const subject = db.appData.subjects.find(s => s.id === req.params.subjectId);
    if (subject && subject.questions[req.params.index]) {
        subject.questions.splice(req.params.index, 1);
        writeDB(db);
        broadcastUpdate();
        res.json({ success: true });
    } else res.status(404).json({ success: false });
});

// GIFTS
app.post('/api/gifts', (req, res) => {
    const db = readDB();
    db.appData.gifts.unshift(req.body);
    writeDB(db);
    broadcastUpdate();
    res.json({ success: true });
});

app.delete('/api/gifts/:id', (req, res) => {
    const db = readDB();
    db.appData.gifts = db.appData.gifts.filter(g => g.id != req.params.id);
    writeDB(db);
    broadcastUpdate();
    res.json({ success: true });
});


app.post('/api/notifications', (req, res) => {
    const db = readDB();
    db.appData.notifications.unshift(req.body);
    writeDB(db);
    io.emit('newNotification', req.body);
    res.json({ success: true });
});

app.post('/api/user/score', (req, res) => {
    const { username, scoreDelta } = req.body;
    const db = readDB();
    
    // Find the user and update their stats
    const user = db.users.find(u => u.user === username);
    if (user) {
        user.score = (user.score || 0) + scoreDelta;
        if (scoreDelta > 0) user.testsTaken = (user.testsTaken || 0) + 1;

        // Sync with APP_DATA.ranking
        let rankUser = db.appData.ranking.find(r => r.name === user.name);
        if (rankUser) {
            rankUser.score = user.score;
        } else {
            db.appData.ranking.push({ name: user.name, score: user.score });
        }

        // Re-sort and slice ranking
        db.appData.ranking.sort((a, b) => b.score - a.score);
        db.appData.ranking = db.appData.ranking.slice(0, 10);

        writeDB(db);
        broadcastUpdate();
        res.json({ success: true, newScore: user.score });
    } else {
        res.status(404).json({ success: false, message: "Foydalanuvchi topilmadi" });
    }
});

app.post('/api/users', (req, res) => {
    const db = readDB();
    const newUser = req.body;
    
    // Check if user already exists
    if (db.users.find(u => u.user === newUser.user)) {
        return res.status(400).json({ success: false, message: "Ushbu login band!" });
    }

    db.users.push({
        ...newUser,
        score: 0,
        testsTaken: 0
    });
    
    writeDB(db);
    broadcastUpdate();
    res.json({ success: true });
});

app.delete('/api/users/:username', (req, res) => {
    const db = readDB();
    const { username } = req.params;

    if (username === 'admin') {
        return res.status(403).json({ success: false, message: "Adminni o'chirib bo'lmaydi!" });
    }

    db.users = db.users.filter(u => u.user !== username);
    writeDB(db);
    broadcastUpdate();
    res.json({ success: true });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
