SELECT id, email, display_name, country, created_at
FROM users
WHERE lower(email) = lower('User13579@Mail.Example')
