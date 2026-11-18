-- Profile pictures: one the person chose, and a copy of their Google picture, each small
-- enough to keep beside the rest of their data (no file storage). See docs/erd.md.
--
-- Numbered 0011: 0010 is taken by the home currency change, landing separately.
--
-- What shows in place of the initial: the picture they chose when there is one, else the
-- Google picture while google_picture is 1 and a copy is kept, else the initial.

CREATE TABLE profile_pictures (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  -- 'upload' for the one they chose, 'google' for the copy of their Google picture
  source TEXT NOT NULL CHECK (source IN ('upload', 'google')),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  -- At most MAX_PICTURE_BYTES (shared/api.ts)
  data BLOB NOT NULL CHECK (typeof(data) = 'blob' AND length(data) BETWEEN 1 AND 65536),
  -- When it was saved, in ms: names this copy, so a browser's copy is known to be current
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer'),
  -- Where a Google picture was copied from, so it's copied again only when that changes
  google_url TEXT CHECK (
    (source = 'google') = (google_url IS NOT NULL) AND (google_url IS NULL OR length(google_url) <= 2048)
  ),
  PRIMARY KEY (email, source)
);

-- Whether the Google picture shows when there's no chosen one (1), or the initial (0)
ALTER TABLE profiles ADD COLUMN google_picture INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(google_picture) = 'integer' AND google_picture IN (0, 1));
