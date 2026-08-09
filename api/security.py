# Password hashing helpers.
#
# We never store plain-text passwords. Instead we store a salted hash
# of the password. Everything here uses Python's built-in `hashlib`,
# so there's nothing extra to install.

import hashlib
import os


def hash_password(password: str, salt: str = None):
    """Turn a plain-text password into a (hash, salt) pair.

    If `salt` isn't given, a new random one is generated - do this
    when a user signs up. If you already have a salt (checking a
    login attempt), pass it in so you get a matching hash back.
    """
    if salt is None:
        salt = os.urandom(16).hex()

    password_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        100_000,  # number of iterations - higher is slower but more secure
    ).hex()

    return password_hash, salt


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    """Check a plain-text password attempt against a stored hash."""
    actual_hash, _ = hash_password(password, salt)
    return actual_hash == expected_hash
