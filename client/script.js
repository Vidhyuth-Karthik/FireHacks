// Frontend logic for the login/signup page (index.html) and the
// home page (home.html). Both pages load this same file - each part
// below only runs if the elements it needs are actually on the page.
//
// The API is hosted separately from this frontend, so every request
// needs the API's full base URL and "credentials: include" so the
// session cookie is sent/received cross-origin. Once the API Space is
// deployed, replace this with its https://*.hf.space URL.

const API_BASE_URL = "https://hackathon-kits.vercel.app";

const messageEl = document.getElementById("message");

function showMessage(text, isError) {
  if (!messageEl) return;
  messageEl.textContent = text;
  messageEl.className = "message " + (isError ? "error" : "success");
}

async function postJSON(path, data) {
  const response = await fetch(API_BASE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include", // send/receive the session cookie cross-origin
    body: JSON.stringify(data),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.detail || "Something went wrong");
  }

  return body;
}

// ---- Login / signup page (index.html) ----

const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");

if (loginForm && signupForm) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));

      button.classList.add("active");
      document.getElementById(button.dataset.tab + "-form").classList.remove("hidden");
      showMessage("", false);
    });
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const userId = document.getElementById("login-user-id").value;
    const password = document.getElementById("login-password").value;

    try {
      await postJSON("/api/auth/login", { user_id: userId, password: password });
      window.location.href = "/home.html";
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const userId = document.getElementById("signup-user-id").value;
    const password = document.getElementById("signup-password").value;

    try {
      await postJSON("/api/auth/signup", { user_id: userId, password: password });
      showMessage("Account created! You can log in now.", false);
      document.querySelector('.tab-button[data-tab="login"]').click();
    } catch (error) {
      showMessage(error.message, true);
    }
  });
}

// ---- Home page (home.html) ----

const userIdDisplay = document.getElementById("user-id-display");
const logoutButton = document.getElementById("logout-button");

if (userIdDisplay) {
  fetch(API_BASE_URL + "/api/auth/me", { credentials: "include" })
    .then((response) => {
      if (!response.ok) throw new Error("Not logged in");
      return response.json();
    })
    .then((data) => {
      userIdDisplay.textContent = data.user_id;
    })
    .catch(() => {
      window.location.href = "/index.html";
    });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    await fetch(API_BASE_URL + "/api/auth/logout", { method: "POST", credentials: "include" });
    window.location.href = "/index.html";
  });
}
