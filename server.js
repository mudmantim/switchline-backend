const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        service: 'switchline-backend'
    });
});

app.get('/test', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Test endpoint working',
        server: 'switchline-backend',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
    });
});

app.listen(PORT, () => {
    console.log(`Minimal Express server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
