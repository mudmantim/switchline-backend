const express = require('express');
const router = express.Router();
const leaderboardController = require('../controllers/leaderboardController');
const { authenticateStreakFitToken } = require('../middleware/auth');

// All leaderboard routes require authentication
router.get('/', authenticateStreakFitToken, leaderboardController.getLeaderboard);
router.get('/rank', authenticateStreakFitToken, leaderboardController.getUserRank);

module.exports = router;
