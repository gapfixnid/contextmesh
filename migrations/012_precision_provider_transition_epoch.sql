ALTER TABLE precision_provider_state
  ADD COLUMN transition_epoch INTEGER NOT NULL DEFAULT 0 CHECK (transition_epoch >= 0);
