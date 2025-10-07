const db = require('../../shared/db');

// Get leaderboard
async function getLeaderboard(req, res) {
  try {
    const { limit = 50, sortBy = 'streak' } = req.query;

    let orderByClause;
    switch (sortBy) {
      case 'calories':
        orderByClause = 's.total_calories DESC, s.current_streak DESC';
        break;
      case 'gold':
        orderByClause = 's.total_gold DESC, s.current_streak DESC';
        break;
      case 'xp':
        orderByClause = 's.total_xp DESC, s.current_streak DESC';
        break;
      case 'streak':
      default:
        orderByClause = 's.current_streak DESC, s.total_calories DESC';
    }

    const result = await db.query(`
      SELECT 
        u.id,
        u.name,
        s.current_streak,
        s.longest_streak,
        s.total_calories,
        s.total_gold,
        s.total_xp
      FROM streakfit_users u
      JOIN streakfit_streaks s ON u.id = s.user_id
      ORDER BY ${orderByClause}
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({
      success: true,
      leaderboard: result.rows
    });

  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch leaderboard'
    });
  }
}

// Get user rank
async function getUserRank(req, res) {
  try {
    const userId = req.user.userId;

    // Get user's rank by streak
    const rankResult = await db.query(`
      WITH ranked_users AS (
        SELECT 
          u.id,
          u.name,
          s.current_streak,
          s.total_calories,
          s.total_gold,
          s.total_xp,
          ROW_NUMBER() OVER (ORDER BY s.current_streak DESC, s.total_calories DESC) as rank
        FROM streakfit_users u
        JOIN streakfit_streaks s ON u.id = s.user_id
      )
      SELECT * FROM ranked_users WHERE id = $1
    `, [userId]);

    if (rankResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      rank: parseInt(rankResult.rows[0].rank),
      stats: {
        current_streak: rankResult.rows[0].current_streak,
        total_calories: rankResult.rows[0].total_calories,
        total_gold: rankResult.rows[0].total_gold,
        total_xp: rankResult.rows[0].total_xp
      }
    });

  } catch (error) {
    console.error('Get user rank error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user rank'
    });
  }
}

module.exports = {
  getLeaderboard,
  getUserRank
};
