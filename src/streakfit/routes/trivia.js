const express = require('express');
const router = express.Router();
const triviaController = require('../controllers/triviaController');
const { authenticateStreakFitToken } = require('../middleware/auth');

// All trivia routes require authentication
router.get('/random', authenticateStreakFitToken, triviaController.getRandomQuestion);
router.post('/answer', authenticateStreakFitToken, triviaController.submitAnswer);
router.get('/categories', authenticateStreakFitToken, triviaController.getCategories);
router.get('/stats', authenticateStreakFitToken, triviaController.getStats);

module.exports = router;
