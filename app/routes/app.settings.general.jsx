// app/routes/app/content/general.jsx
import { useState, useEffect } from "react";

export default function GeneralSettings() {
  const [settings, setSettings] = useState({
    appName: "Enhanced Content Manager",
    timeZone: "UTC+5:30",
    language: "English",
  });

  // Load settings from DB (use loader or fetch inside useEffect if needed)

  function handleChange(e) {
    setSettings({ ...settings, [e.target.name]: e.target.value });
  }

  function handleSave() {
    // Send to server (POST or PUT to /api/settings/general)
    console.log("Saving settings:", settings);
  }

  return (
    <div>
      <h1 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "20px" }}>General Settings</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "400px" }}>
        <label>
          App Name
          <input name="appName" value={settings.appName} onChange={handleChange} />
        </label>
        <label>
          Time Zone
          <select name="timeZone" value={settings.timeZone} onChange={handleChange}>
            <option value="UTC+5:30">UTC+5:30 (IST)</option>
            <option value="UTC-5">UTC-5 (EST)</option>
            {/* more zones */}
          </select>
        </label>
        <label>
          Language
          <select name="language" value={settings.language} onChange={handleChange}>
            <option value="English">English</option>
            <option value="French">French</option>
          </select>
        </label>

        <button
          onClick={handleSave}
          style={{ background: "#7c3aed", color: "#fff", padding: "10px", borderRadius: "6px" }}
        >
          Save Changes
        </button>
      </div>
    </div>
  );
}
