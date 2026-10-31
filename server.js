const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const DB_FILE = path.join(__dirname, 'database.json');

function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], communities: [], messages: {} }));
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. Регистрация
app.post('/api/register', async (req, res) => {
    const { email, name, password } = req.body;
    const db = readDB();
    
    if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Эта почта уже занята' });
    if (db.users.find(u => u.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'Это имя уже занято' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: Date.now().toString(), email, name, password: hashedPassword, messageCount: 0, createdAt: new Date(), lastMsgTime: 0 };
    db.users.push(newUser);
    writeDB(db);
    
    res.json({ success: true, user: { id: newUser.id, email, name: newUser.name, messageCount: 0, createdAt: newUser.createdAt } });
});

// 2. Вход
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const db = readDB();
    
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: 'Неверный пароль' });

    res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, messageCount: user.messageCount || 0, createdAt: user.createdAt } });
});

// 3. ГЛОБАЛЬНЫЙ ПОИСК (только открытые)
app.get('/api/search-communities', (req, res) => {
    const query = req.query.q ? req.query.q.toLowerCase() : '';
    const db = readDB();
    const results = db.communities.filter(c => 
        c.type === 'open' && c.name.toLowerCase().includes(query)
    );
    res.json(results);
});

// 4. Вступление в открытую группу
app.post('/api/communities/join', (req, res) => {
    const { communityId, userId } = req.body;
    const db = readDB();
    const comm = db.communities.find(c => c.id === communityId);
    
    if (!comm) return res.status(404).json({ error: 'Не найдено' });
    if (!comm.members.includes(userId)) {
        comm.members.push(userId);
        writeDB(db);
    }
    res.json({ success: true, community: comm });
});

// 4.5. Получить сообщество по ID (для ссылок-приглашений)
app.get('/api/communities/:id', (req, res) => {
    const db = readDB();
    const comm = db.communities.find(c => c.id === req.params.id);
    if (!comm) return res.status(404).json({ error: 'Не найдено' });
    res.json(comm);
});

// 5. Получение сообществ пользователя
app.get('/api/my-communities/:userId', (req, res) => {
    const db = readDB();
    const userId = req.params.userId;
    const myComms = db.communities.filter(c => c.members.includes(userId));
    res.json(myComms);
});

// 6. Проверка пароля (закрытые)
app.post('/api/communities/verify', async (req, res) => {
    const { communityId, password, userId } = req.body;
    const db = readDB();
    const comm = db.communities.find(c => c.id === communityId);
    
    if (!comm) return res.status(404).json({ error: 'Не найдено' });
    const validPass = await bcrypt.compare(password, comm.password);
    if (!validPass) return res.json({ success: false });

    if (!comm.members.includes(userId)) {
        comm.members.push(userId);
        writeDB(db);
    }
    res.json({ success: true });
});

// 7. Создание сообщества
app.post('/api/communities', (req, res) => {
    const { name, type, password, creatorId, isHiddenAdmin } = req.body;
    const db = readDB();
    
    const newComm = { 
        id: Date.now().toString(), 
        name, 
        type, 
        password: password ? bcrypt.hashSync(password, 10) : null,
        creatorId,
        isHiddenAdmin: isHiddenAdmin || false,
        members: [creatorId],
        theme: 'theme-neon',
        avatar: ''
    };
    
    db.communities.push(newComm);
    writeDB(db);
    res.json({ success: true, community: newComm });
});

// 8. Отправка сообщения (уровни, антиспам 10сек)
app.post('/api/messages', async (req, res) => {
    const { communityId, userId, userName, text, avatar, isVoice, voiceData } = req.body;
    const db = readDB();
    
    if (!db.messages[communityId]) db.messages[communityId] = [];
    const now = Date.now();
    const user = db.users.find(u => u.id === userId);
    
    let countMessage = false;
    let newLevel = false;
    
    if (user && !isVoice && text.trim().length > 2) {
        if (now - (user.lastMsgTime || 0) > 10000) {
            user.messageCount = (user.messageCount || 0) + 1;
            user.lastMsgTime = now;
            countMessage = true;
            
            const getLvl = (c) => { if(c>=250) return 10 + Math.floor((c-250)/50); if(c>=200) return 9; if(c>=150) return 8; if(c>=100) return 7; if(c>=70) return 6; if(c>=50) return 5; if(c>=30) return 4; if(c>=10) return 3; if(c>=5) return 2; if(c>=1) return 1; return 0; };
            if (getLvl(user.messageCount) > getLvl(user.messageCount - 1)) newLevel = true;
            
            writeDB(db);
        }
    }

    const msg = { id: Date.now().toString(), userId, userName, text, avatar, isVoice, voiceData, time: new Date() };
    db.messages[communityId].push(msg);
    writeDB(db);
    
    res.json({ success: true, message: msg, newCount: user ? user.messageCount : 0, newLevel });
});

// 9. Получение сообщений
app.get('/api/messages/:communityId', (req, res) => {
    const db = readDB();
    res.json(db.messages[req.params.communityId] || []);
});

// 10. Кик участника
app.post('/api/communities/kick', (req, res) => {
    const { communityId, creatorId, targetId } = req.body;
    const db = readDB();
    const comm = db.communities.find(c => c.id === communityId);
    
    if (comm && comm.creatorId === creatorId) {
        comm.members = comm.members.filter(id => id !== targetId);
        writeDB(db);
        return res.json({ success: true });
    }
    res.status(403).json({ error: 'Нет прав' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 BlikLite Сервер запущен! (Поиск + Ссылки)`);
    console.log(`👉 Открой в браузере: http://localhost:${PORT}\n`);
});
