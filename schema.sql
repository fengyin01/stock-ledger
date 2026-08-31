CREATE TABLE IF NOT EXISTS rooms (
  room_id    TEXT    PRIMARY KEY,
  state      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
