const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.json());

// CORS headers for frontend requests
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.get('/', (req, res) => {
    res.send('Hello World');
});

app.get('/test-basic', (req, res) => {
    res.json({
        status: 'success',
        message: 'Basic test endpoint working',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/twilio/test', (req, res) => {
    try {
        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
            return res.status(500).json({
                status: 'error',
                message: 'Twilio credentials not configured'
            });
        }

        res.json({
            status: 'success',
            message: 'Twilio API test endpoint working',
            accountSid: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'missing',
            authToken: process.env.TWILIO_AUTH_TOKEN ? 'configured' : 'missing'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Twilio test failed',
            error: error.message
        });
    }
});

app.post('/api/sms/send', async (req, res) => {
    try {
        const { to, from, body } = req.body;

        if (!to || !from || !body) {
            return res.status(400).json({
                status: 'error',
                message: 'Missing required fields: to, from, body'
            });
        }

        const message = await client.messages.create({
            body: body,
            from: from,
            to: to
        });

        res.json({
            status: 'success',
            message: 'SMS sent successfully',
            messageSid: message.sid
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to send SMS',
            error: error.message
        });
    }
});

app.post('/webhook/sms', (req, res) => {
    const { From, Body, MessageSid } = req.body;

    console.log('Received SMS webhook:', {
        from: From,
        body: Body,
        messageSid: MessageSid
    });

    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>Thanks for your message!</Message>
</Response>`);
});

app.post('/webhook/voice', (req, res) => {
    const { From, CallSid } = req.body;

    console.log('Received voice webhook:', {
        from: From,
        callSid: CallSid
    });

    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Hello from Switchline!</Say>
</Response>`);
});

app.listen(3001);
