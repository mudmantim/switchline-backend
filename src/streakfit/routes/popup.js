const express = require('express');
const router = express.Router();
const popupController = require('../controllers/popupController');
const { authenticateStreakFitToken } = require('../middleware/auth');

// All popup routes require authentication
router.get('/active', authenticateStreakFitToken, popupController.getActivePopup);
router.post('/complete', authenticateStreakFitToken, popupController.completePopup);
router.post('/generate', authenticateStreakFitToken, popupController.generatePopups);
router.get('/history', authenticateStreakFitToken, popupController.getHistory);

module.exports = router;
