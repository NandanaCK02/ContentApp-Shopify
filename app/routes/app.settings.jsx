import { Link, Outlet, useLocation } from "@remix-run/react";

const contentLinks = [
  { to: "/app/settings/general", label: "  General" },
  { to: "/app/settings/appearance", label: " Appearance" },
  { to: "/app/settings/notification", label: "Notifications" },
  { to: "/app/settings/security", label: "Security" },
  { to: "/app/settings/team", label: "Team" },
  { to: "/app/settings/apikey", label: "API-KEY" },
];

export default function ContentBuilderLayout() {
  const location = useLocation();

  return (
    <div style={{ display: "flex", height: "100vh", backgroundColor: "#f9fafb" }}>
      {/* Mini-sidebar for content types */}
      <aside
        style={{
          width: "260px",
          backgroundColor: "#fffef2",
          borderRight: "1px solid #e5e7eb",
          padding: "1.5rem",
        }}
      >
        <h2 style={{ fontSize: "18px", fontWeight: "600", marginBottom: "1.2rem" }}>
          Content Types
        </h2>

        <nav style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {contentLinks.map((link) => {
            const isActive = location.pathname === link.to;
            return (
              <Link
                key={link.to}
                to={link.to}
                style={{
                  padding: "10px 14px",
                  borderRadius: "8px",
                  backgroundColor: isActive ? "#7c3aed" : "transparent",
                  color: isActive ? "#fff" : "#111827",
                  textDecoration: "none",
                  fontWeight: isActive ? "600" : "500",
                  transition: "background 0.2s",
                  border: isActive ? "1px solid #7c3aed" : "1px solid transparent",
                }}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Editor Area */}
      <main style={{ flex: 1, padding: "2rem" }}>
        <Outlet />
      </main>
    </div>
  );
}
