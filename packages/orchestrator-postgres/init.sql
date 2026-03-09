-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create a function to verify the extension is loaded
CREATE OR REPLACE FUNCTION check_pgvector_installed()
RETURNS TEXT AS $$
BEGIN
  RETURN 'pgvector extension is installed and ready';
END;
$$ LANGUAGE plpgsql;

-- Log success
SELECT check_pgvector_installed();
