const express = require('express');
const router = express.Router();
const workoutController = require('../controllers/workoutController');
const { authenticateStreakFitToken } = require('../middleware/auth');

// All workout routes require authentication
router.get('/daily-workout', authenticateStreakFitToken, workoutController.getDailyWorkoutForUser);
router.post('/complete-exercise', authenticateStreakFitToken, workoutController.completeExercise);
router.post('/update-fitness-level', authenticateStreakFitToken, workoutController.updateFitnessLevel);
router.get('/fitness-level', authenticateStreakFitToken, workoutController.getFitnessLevel);

module.exports = router;
