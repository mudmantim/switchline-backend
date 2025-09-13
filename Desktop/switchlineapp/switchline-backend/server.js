const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
}));

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

app.get('/test', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Test endpoint working',
        server: 'switchline-backend',
        version: '1.0.0'
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
