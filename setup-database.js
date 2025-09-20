const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const setupDatabase = async () => {
  const client = await pool.connect();
  
  try {
    console.log('🗄️  Starting database setup...');
    
    // Enable necessary extensions
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    `);
    
    // Create custom types
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE user_status AS ENUM ('active', 'suspended', 'banned', 'pending_verification');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
      
      DO $$ BEGIN
        CREATE TYPE subscription_status AS ENUM ('active', 'inactive', 'past_due', 'canceled', 'trialing');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
      
      DO $$ BEGIN
        CREATE TYPE phone_number_status AS ENUM ('active', 'inactive', 'suspended', 'burned');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
      
      DO $$ BEGIN
        CREATE TYPE message_type AS ENUM ('sms', 'mms');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
      
      DO $$ BEGIN
        CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
      
      DO $$ BEGIN
        CREATE TYPE call_status AS ENUM ('completed', 'busy', 'failed', 'no-answer', 'canceled');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
    
    // Create subscription_plans table first (referenced by users)
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        price_cents INTEGER NOT NULL,
        billing_interval VARCHAR(20) DEFAULT 'monthly',
        
        -- Plan limits
        phone_numbers_limit INTEGER NOT NULL,
        minutes_limit INTEGER NOT NULL,
        sms_limit INTEGER NOT NULL,
        
        -- Features
        features JSONB DEFAULT '{}',
        
        -- Stripe integration
        stripe_price_id VARCHAR(255),
        stripe_product_id VARCHAR(255),
        
        -- Status
        active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        CONSTRAINT price_positive CHECK (price_cents >= 0),
        CONSTRAINT limits_positive CHECK (
          phone_numbers_limit > 0 AND 
          minutes_limit >= 0 AND 
          sms_limit >= 0
        )
      );
    `);
    
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) UNIQUE NOT NULL,
        email_verified BOOLEAN DEFAULT FALSE,
        password_hash VARCHAR(255) NOT NULL,
        salt VARCHAR(255) NOT NULL,
        
        -- Profile information
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        timezone VARCHAR(50) DEFAULT 'UTC',
        
        -- Account status and security
        status user_status DEFAULT 'pending_verification',
        two_factor_enabled BOOLEAN DEFAULT FALSE,
        two_factor_secret VARCHAR(32),
        backup_codes TEXT[],
        
        -- Security tracking
        failed_login_attempts INTEGER DEFAULT 0,
        account_locked_until TIMESTAMP,
        password_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        -- Subscription and limits
        subscription_plan_id UUID REFERENCES subscription_plans(id),
        stripe_customer_id VARCHAR(255),
        phone_numbers_limit INTEGER DEFAULT 1,
        minutes_limit INTEGER DEFAULT 100,
        sms_limit INTEGER DEFAULT 50,
        
        -- Active phone number
        active_phone_number_id UUID,
        
        -- API access
        api_key_hash VARCHAR(255),
        api_calls_remaining INTEGER DEFAULT 0,
        
        -- Metadata
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP,
        last_activity_at TIMESTAMP,
        
        -- Privacy settings
        data_retention_days INTEGER DEFAULT 90,
        auto_delete_messages BOOLEAN DEFAULT FALSE,
        
        CONSTRAINT email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$'),
        CONSTRAINT failed_attempts_check CHECK (failed_login_attempts >= 0),
        CONSTRAINT limits_check CHECK (
          phone_numbers_limit > 0 AND 
          minutes_limit >= 0 AND 
          sms_limit >= 0
        )
      );
    `);
    
    // Create phone_numbers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS phone_numbers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        
        -- Phone number details
        phone_number VARCHAR(20) NOT NULL UNIQUE,
        formatted_number VARCHAR(25),
        country_code VARCHAR(3) DEFAULT 'US',
        area_code VARCHAR(5),
        
        -- Twilio integration
        twilio_sid VARCHAR(255),
        twilio_account_sid VARCHAR(255),
        
        -- Status and lifecycle
        status phone_number_status DEFAULT 'active',
        purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        burned_at TIMESTAMP,
        expires_at TIMESTAMP,
        
        -- Usage tracking
        total_calls INTEGER DEFAULT 0,
        total_messages INTEGER DEFAULT 0,
        last_used_at TIMESTAMP,
        
        -- Configuration
        voice_url VARCHAR(500),
        sms_url VARCHAR(500),
        
        -- Metadata
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        CONSTRAINT phone_format CHECK (phone_number ~ '^\\+?[1-9]\\d{1,14}$'),
        CONSTRAINT usage_positive CHECK (total_calls >= 0 AND total_messages >= 0),
        CONSTRAINT burned_logic CHECK (
          (status = 'burned' AND burned_at IS NOT NULL) OR 
          (status != 'burned' AND burned_at IS NULL)
        )
      );
    `);
    
    // Create calls table
    await client.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        phone_number_id UUID REFERENCES phone_numbers(id) ON DELETE SET NULL,
        
        -- Call details
        from_number VARCHAR(20) NOT NULL,
        to_number VARCHAR(20) NOT NULL,
        direction call_direction NOT NULL,
        
        -- Twilio integration
        twilio_sid VARCHAR(255) UNIQUE,
        twilio_parent_call_sid VARCHAR(255),
        
        -- Call status and timing
        status call_status DEFAULT 'completed',
        duration INTEGER,
        price_cents INTEGER,
        
        -- Timestamps
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        answered_at TIMESTAMP,
        ended_at TIMESTAMP,
        
        -- Recording (if enabled)
        recording_url VARCHAR(500),
        recording_duration INTEGER,
        
        -- Metadata
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        CONSTRAINT duration_positive CHECK (duration IS NULL OR duration >= 0),
        CONSTRAINT price_positive CHECK (price_cents IS NULL OR price_cents >= 0),
        CONSTRAINT timing_logic CHECK (
          (answered_at IS NULL OR answered_at >= started_at) AND
          (ended_at IS NULL OR ended_at >= started_at)
        )
      );
    `);
    
    // Create messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        phone_number_id UUID REFERENCES phone_numbers(id) ON DELETE SET NULL,
        
        -- Message details
        from_number VARCHAR(20) NOT NULL,
        to_number VARCHAR(20) NOT NULL,
        body TEXT,
        direction call_direction NOT NULL,
        message_type message_type DEFAULT 'sms',
        
        -- Twilio integration
        twilio_sid VARCHAR(255) UNIQUE,
        twilio_account_sid VARCHAR(255),
        
        -- Status and delivery
        status VARCHAR(50) DEFAULT 'sent',
        error_code INTEGER,
        error_message TEXT,
        price_cents INTEGER,
        
        -- Media attachments (for MMS)
        media_urls TEXT[],
        num_media INTEGER DEFAULT 0,
        
        -- Metadata
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        CONSTRAINT body_or_media CHECK (body IS NOT NULL OR num_media > 0),
        CONSTRAINT media_consistency CHECK (
          (num_media = 0 AND media_urls IS NULL) OR
          (num_media > 0 AND array_length(media_urls, 1) = num_media)
        ),
        CONSTRAINT price_positive CHECK (price_cents IS NULL OR price_cents >= 0)
      );
    `);
    
    // Create subscriptions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_plan_id UUID NOT NULL REFERENCES subscription_plans(id),
        
        -- Stripe integration
        stripe_subscription_id VARCHAR(255) UNIQUE,
        stripe_customer_id VARCHAR(255),
        stripe_price_id VARCHAR(255),
        
        -- Subscription status
        status subscription_status DEFAULT 'active',
        trial_end TIMESTAMP,
        current_period_start TIMESTAMP,
        current_period_end TIMESTAMP,
        cancel_at_period_end BOOLEAN DEFAULT FALSE,
        canceled_at TIMESTAMP,
        
        -- Usage tracking for current period
        phone_numbers_used INTEGER DEFAULT 0,
        minutes_used INTEGER DEFAULT 0,
        sms_used INTEGER DEFAULT 0,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        CONSTRAINT usage_positive CHECK (
          phone_numbers_used >= 0 AND 
          minutes_used >= 0 AND 
          sms_used >= 0
        )
      );
    `);
    
    // Create invoices table
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
        
        -- Stripe integration
        stripe_invoice_id VARCHAR(255) UNIQUE,
        stripe_payment_intent_id VARCHAR(255),
        
        -- Invoice details
        amount_cents INTEGER NOT NULL,
        currency VARCHAR(3) DEFAULT 'USD',
        description TEXT,
        
        -- Status and dates
        status VARCHAR(50) DEFAULT 'draft',
        due_date DATE,
        paid_at TIMESTAMP,
        
        -- Billing period
        period_start DATE,
        period_end DATE,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        CONSTRAINT amount_positive CHECK (amount_cents > 0)
      );
    `);
    
    // Add foreign key constraint for active_phone_number_id
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD CONSTRAINT fk_users_active_phone_number 
          FOREIGN KEY (active_phone_number_id) REFERENCES phone_numbers(id);
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
    
    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
      CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id);
      CREATE INDEX IF NOT EXISTS idx_phone_numbers_user_id ON phone_numbers(user_id);
      CREATE INDEX IF NOT EXISTS idx_phone_numbers_status ON phone_numbers(status);
      CREATE INDEX IF NOT EXISTS idx_phone_numbers_phone_number ON phone_numbers(phone_number);
      CREATE INDEX IF NOT EXISTS idx_phone_numbers_twilio_sid ON phone_numbers(twilio_sid);
      CREATE INDEX IF NOT EXISTS idx_calls_user_id ON calls(user_id);
      CREATE INDEX IF NOT EXISTS idx_calls_phone_number_id ON calls(phone_number_id);
      CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at);
      CREATE INDEX IF NOT EXISTS idx_calls_twilio_sid ON calls(twilio_sid);
      CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_phone_number_id ON messages(phone_number_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at);
      CREATE INDEX IF NOT EXISTS idx_messages_twilio_sid ON messages(twilio_sid);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);
    `);
    
    // Create update timestamp function
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);
    
    // Create triggers for automatic timestamp updates
    await client.query(`
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users 
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      
      DROP TRIGGER IF EXISTS update_phone_numbers_updated_at ON phone_numbers;
      CREATE TRIGGER update_phone_numbers_updated_at BEFORE UPDATE ON phone_numbers 
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      
      DROP TRIGGER IF EXISTS update_calls_updated_at ON calls;
      CREATE TRIGGER update_calls_updated_at BEFORE UPDATE ON calls 
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      
      DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;
      CREATE TRIGGER update_messages_updated_at BEFORE UPDATE ON messages 
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      
      DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
      CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions 
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);
    
    // Insert default subscription plans
    await client.query(`
      INSERT INTO subscription_plans (name, description, price_cents, phone_numbers_limit, minutes_limit, sms_limit, sort_order) 
      VALUES 
        ('Basic', 'Perfect for personal use', 399, 1, 500, 200, 1),
        ('Pro', 'Great for power users', 999, 3, 2000, 1000, 2),
        ('Business', 'For teams and enterprises', 2999, 10, 10000, 5000, 3)
      ON CONFLICT (name) DO NOTHING;
    `);
    
    console.log('✅ Database setup completed successfully!');
    console.log('📋 Created tables: users, phone_numbers, calls, messages, subscriptions, invoices, subscription_plans');
    console.log('🔍 Created indexes for performance optimization');
    console.log('⚡ Created triggers for automatic timestamp updates');
    console.log('📦 Inserted default subscription plans');
    
    // Verify setup
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    
    console.log('📊 Tables created:', result.rows.map(row => row.table_name).join(', '));
    
  } catch (error) {
    console.error('❌ Database setup failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Export for use in other files
module.exports = { setupDatabase };

// Run directly if this file is executed
if (require.main === module) {
  setupDatabase()
    .then(() => {
      console.log('🎉 Database is ready for production!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Setup failed:', error);
      process.exit(1);
    });
}