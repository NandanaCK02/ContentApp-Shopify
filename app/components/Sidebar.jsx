import { Link, useLocation } from "@remix-run/react";

const links = [
  {to: "/app/dashboard", label: " Dashboard" },
  { to: "/app/content", label: " Content Builder" },
  { to: "/app/metafield", label: "Metafield Editor" },
  { to: "/app/media", label: " Media" }, 
  { to: "/app/faq", label: " FAQ-Manager" },
  { to: "/app/settings", label: " Settings" }
];



export default function Sidebar() {
  const location = useLocation();

  return (
    <aside
      style={{
        width: "220px",
        height: "100vh",
        backgroundColor: "#11111a",
        padding: "20px",
        color: "white",
        display: "flex",
        flexDirection: "column"
      }}
    >
      <h3
        style={{
          color: "#fff",
          fontSize: "1.25rem",
          marginBottom: "1.5rem",
          fontWeight: "bold"
        }}
      >
        Enhanced Content
      </h3>

      <nav style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {links.map(link => (
          <Link
            key={link.to}
            to={link.to}
            style={{
              padding: "10px 15px",
              borderRadius: "8px",
              backgroundColor: location.pathname.startsWith(link.to)
                ? "#5c00e0"
                : "transparent",
              color: location.pathname.startsWith(link.to) ? "#fff" : "#f0f0f0",
              fontWeight: location.pathname.startsWith(link.to) ? "bold" : "normal",
              textDecoration: "none",
              transition: "background 0.2s ease"
            }}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
