# Handles the database connection and setup.
#
# The database is hosted on Turso (a SQLite-compatible service) instead
# of a local file, since this API deploys as a Docker Space on Hugging
# Face - the container's disk is wiped on every restart, so anything
# written to a local file wouldn't survive a redeploy. Create a free
# database at https://turso.tech, then set TURSO_DATABASE_URL and
# TURSO_AUTH_TOKEN - copy .env.example to .env and fill them in for
# local dev, or set them as Space secrets in production.

import os

import libsql
from dotenv import load_dotenv

load_dotenv()

TURSO_DATABASE_URL = os.environ["TURSO_DATABASE_URL"]
TURSO_AUTH_TOKEN = os.environ["TURSO_AUTH_TOKEN"]


def get_connection():
    """Open a new connection to the Turso database.

    Each request opens and closes its own connection. That's a bit
    less "efficient" than sharing one connection, but it's much
    easier to reason about when you're learning - no shared state,
    no threading surprises.
    """
    return libsql.connect(database=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)


def row_to_dict(cursor, row):
    """Turn a plain result row into a dict keyed by column name.

    Unlike Python's built-in sqlite3 module, libsql's cursor returns
    rows as plain tuples with no name-based access - this rebuilds
    that convenience (`row["user_id"]`) from cursor.description.
    """
    if row is None:
        return None
    columns = [column[0] for column in cursor.description]
    return dict(zip(columns, row))


def init_db():
    """Create the tables the app needs, if they don't already exist.

    Called once when the server starts up (see main.py).
    """
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users (user_id)
        )
        """
    )

    conn.commit()
    conn.close()
