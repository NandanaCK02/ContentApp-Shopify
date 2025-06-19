import { useRef } from "react";

export default function RichDescriptionPage() {
  const editorRef = useRef();

  const formatText = (command) => {
    document.execCommand(command, false, null);
    editorRef.current.focus();
  };

  const insertLink = () => {
    const url = prompt("Enter URL:");
    if (url) document.execCommand("createLink", false, url);
  };

  const insertImage = () => {
    const imageUrl = prompt("Enter image URL:");
    if (imageUrl) document.execCommand("insertImage", false, imageUrl);
  };

  return (
    <div style={{ maxWidth: 800, margin: "2rem auto", padding: "1rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button onClick={() => formatText("bold")} style={btnStyle}>Bold</button>
        <button onClick={() => formatText("italic")} style={btnStyle}>Italic</button>
        <button onClick={insertLink} style={btnStyle}>Link</button>
        <button onClick={insertImage} style={btnStyle}>Image</button>
      </div>

      <div
        ref={editorRef}
        contentEditable
        placeholder="Write your detailed product description here…"
        style={{
          minHeight: "250px",
          border: "1px solid #e5e7eb",
          padding: "1rem",
          borderRadius: "8px",
          fontSize: "16px",
          outline: "none",
          background: "#fff"
        }}
      />
    </div>
  );
}

const btnStyle = {
  padding: "8px 12px",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  background: "#f9fafb",
  cursor: "pointer",
  fontWeight: "500"
};
