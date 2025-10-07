const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateStreakFitToken } = require('../middleware/auth');

// Public routes
router.post('/signup', authController.signup);
router.post('/login', authController.login);

// Protected routes
router.post('/logout', authenticateStreakFitToken, authController.logout);
router.get('/me', authenticateStreakFitToken, authController.getCurrentUser);
router.get('/user/:userId', authenticateStreakFitToken, authController.getUserStats);

module.exports = router;
