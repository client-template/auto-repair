document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = e.target.password.value;
  const errorEl = document.getElementById("loginError");
  errorEl.style.display = "none";

  try {
    const res = await fetch(`${API_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    sessionStorage.setItem("site_token", data.token);
    window.location.href = "/mysite/edit.html";
  } catch (err) {
    // Show rate-limit messages as-is; generic message for everything else
    if (err.message && err.message.includes("Too many login attempts")) {
      errorEl.textContent = "Too many login attempts. Please try again later.";
    } else {
      errorEl.textContent = "Invalid password. Please try again.";
    }
    errorEl.style.display = "block";
  }
});
