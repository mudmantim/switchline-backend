const db = require('../../shared/db');
const { getDailyWorkout, getWorkoutById } = require('../services/workoutData');

// Get today's daily workout
async function getDailyWorkoutForUser(req, res) {
  try {
    const userId = req.user.userId;

    // Get user's fitness level
    const userResult = await db.query(
      'SELECT fitness_level FROM streakfit_user_progress WHERE user_id = $1',
      [userId]
    );

    const fitnessLevel = userResult.rows[0]?.fitness_level || 'beginner';

    // Generate today's workout
    const dailyExercises = getDailyWorkout(fitnessLevel);

    // Check which exercises user has completed today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const completedResult = await db.query(`
      SELECT workout_id FROM streakfit_workout_progress
      WHERE user_id = $1 AND completed_at >= $2
    `, [userId, todayStart]);

    const completedIds = new Set(completedResult.rows.map(r => r.workout_id));

    // Mark which exercises are completed
    const workoutWithProgress = dailyExercises.map(exercise => ({
      ...exercise,
      completed: completedIds.has(exercise.id)
    }));

    const totalExercises = dailyExercises.length;
    const completedCount = workoutWithProgress.filter(e => e.completed).length;
    const isComplete = completedCount === totalExercises;

    res.json({
      success: true,
      fitnessLevel: fitnessLevel,
      exercises: workoutWithProgress,
      progress: {
        completed: completedCount,
        total: totalExercises,
        percentage: Math.round((completedCount / totalExercises) * 100),
        isComplete: isComplete
      }
    });

  } catch (error) {
    console.error('Get daily workout error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get daily workout'
    });
  }
}

// Complete one exercise from daily workout
async function completeExercise(req, res) {
  try {
    const { exerciseId } = req.body;
    const userId = req.user.userId;

    if (!exerciseId) {
      return res.status(400).json({
        success: false,
        error: 'Exercise ID required'
      });
    }

    // Find the exercise
    const exercise = getWorkoutById(exerciseId);

    if (!exercise) {
      return res.status(404).json({
        success: false,
        error: 'Exercise not found'
      });
    }

    // Check if already completed today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const existingResult = await db.query(`
      SELECT id FROM streakfit_workout_progress
      WHERE user_id = $1 AND workout_id = $2 AND completed_at >= $3
    `, [userId, exerciseId, todayStart]);

    if (existingResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Exercise already completed today'
      });
    }

    // Record completion
    await db.query(`
      INSERT INTO streakfit_workout_progress 
      (user_id, workout_id, workout_name, gold_earned, xp_earned, completed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, exercise.id, exercise.name, exercise.gold, exercise.xp]);

    // Update user totals
    await db.query(`
      UPDATE streakfit_streaks 
      SET total_gold = total_gold + $1,
          total_xp = total_xp + $2
      WHERE user_id = $3
    `, [exercise.gold, exercise.xp, userId]);

    // Check if daily workout is now complete
    const userResult = await db.query(
      'SELECT fitness_level FROM streakfit_user_progress WHERE user_id = $1',
      [userId]
    );

    const fitnessLevel = userResult.rows[0]?.fitness_level || 'beginner';
    const todayWorkout = getDailyWorkout(fitnessLevel);

    const completedTodayResult = await db.query(`
      SELECT COUNT(*) FROM streakfit_workout_progress
      WHERE user_id = $1 AND completed_at >= $2
    `, [userId, todayStart]);

    const completedCount = parseInt(completedTodayResult.rows[0].count);
    const workoutComplete = completedCount >= todayWorkout.length;

    // If workout complete, award bonus and update streak
    if (workoutComplete) {
      const bonusGold = 50;
      const bonusXP = 100;

      // Update totals with bonus
      await db.query(`
        UPDATE streakfit_streaks 
        SET total_gold = total_gold + $1,
            total_xp = total_xp + $2
        WHERE user_id = $3
      `, [bonusGold, bonusXP, userId]);

      // Update streak
      const streakResult = await db.query(
        'SELECT * FROM streakfit_streaks WHERE user_id = $1',
        [userId]
      );

      if (streakResult.rows.length > 0) {
        const streak = streakResult.rows[0];
        const lastCompleted = streak.last_completed ? new Date(streak.last_completed) : null;
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        let newStreak = 1;
        if (lastCompleted && lastCompleted >= yesterday) {
          newStreak = streak.current_streak + 1;
        }

        const newLongest = Math.max(newStreak, streak.longest_streak);

        await db.query(`
          UPDATE streakfit_streaks 
          SET current_streak = $1, 
              longest_streak = $2,
              last_completed = NOW()
          WHERE user_id = $3
        `, [newStreak, newLongest, userId]);
      }

      // Get updated streak data
      const updatedStreakResult = await db.query(
        'SELECT * FROM streakfit_streaks WHERE user_id = $1',
        [userId]
      );

      return res.json({
        success: true,
        exerciseCompleted: true,
        workoutComplete: true,
        goldEarned: exercise.gold + bonusGold,
        xpEarned: exercise.xp + bonusXP,
        bonusAwarded: true,
        streak: updatedStreakResult.rows[0],
        allCompleted: true,
        message: 'Daily workout complete! Bonus awarded!'
      });
    }

    // Get updated totals
    const updatedStreakResult = await db.query(
      'SELECT * FROM streakfit_streaks WHERE user_id = $1',
      [userId]
    );

    res.json({
      success: true,
      exerciseCompleted: true,
      workoutComplete: false,
      goldEarned: exercise.gold,
      xpEarned: exercise.xp,
      remainingExercises: todayWorkout.length - completedCount,
      streak: updatedStreakResult.rows[0],
      allCompleted: false
    });

  } catch (error) {
    console.error('Complete exercise error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete exercise'
    });
  }
}

// Update user fitness level
async function updateFitnessLevel(req, res) {
  try {
    const { level } = req.body;
    const userId = req.user.userId;

    if (!['beginner', 'intermediate', 'advanced'].includes(level)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid fitness level. Must be: beginner, intermediate, or advanced'
      });
    }

    await db.query(`
      INSERT INTO streakfit_user_progress (user_id, fitness_level, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET fitness_level = $2, updated_at = NOW()
    `, [userId, level]);

    res.json({
      success: true,
      fitnessLevel: level,
      message: `Fitness level updated to ${level}`
    });

  } catch (error) {
    console.error('Update fitness level error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update fitness level'
    });
  }
}

// Get user fitness level
async function getFitnessLevel(req, res) {
  try {
    const userId = req.user.userId;

    const result = await db.query(
      'SELECT fitness_level FROM streakfit_user_progress WHERE user_id = $1',
      [userId]
    );

    const fitnessLevel = result.rows[0]?.fitness_level || null;

    res.json({
      success: true,
      fitnessLevel: fitnessLevel
    });

  } catch (error) {
    console.error('Get fitness level error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get fitness level'
    });
  }
}

module.exports = {
  getDailyWorkoutForUser,
  completeExercise,
  updateFitnessLevel,
  getFitnessLevel
};
