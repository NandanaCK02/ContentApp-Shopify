import { useState } from "react";

export default function TableDemoPage() {
  const [rows, setRows] = useState([
    { name: "", value: "" },
  ]);

  const handleAddRow = () => {
    setRows([...rows, { name: "", value: "" }]);
  };

  const handleChange = (index, field, value) => {
    const updated = [...rows];
    updated[index][field] = value;
    setRows(updated);
  };

  const handleRemove = (index) => {
    setRows(rows.filter((_, i) => i !== index));
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "1rem" }}>
      <h2 style={{ fontSize: "1.5rem", fontWeight: "600", marginBottom: "1.5rem" }}>
        Feature Table (Demo)
      </h2>

      <table style={{
        width: "100%",
        borderCollapse: "collapse",
        marginBottom: "1rem",
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        overflow: "hidden"
      }}>
        <thead style={{ backgroundColor: "#f3f4f6" }}>
          <tr>
            <th style={thStyle}>Feature Name</th>
            <th style={thStyle}>Feature Value</th>
            <th style={thStyle}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td style={tdStyle}>
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => handleChange(index, "name", e.target.value)}
                  placeholder="Name"
                  style={inputStyle}
                />
              </td>
              <td style={tdStyle}>
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => handleChange(index, "value", e.target.value)}
                  placeholder="Value"
                  style={inputStyle}
                />
              </td>
              <td style={tdStyle}>
                <button
                  onClick={() => handleRemove(index)}
                  style={{
                    background: "#ef4444",
                    color: "#fff",
                    border: "none",
                    padding: "6px 12px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontWeight: "500"
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button
        onClick={handleAddRow}
        style={{
          backgroundColor: "#4f46e5",
          color: "#fff",
          border: "none",
          borderRadius: "6px",
          padding: "10px 20px",
          fontWeight: "600",
          cursor: "pointer"
        }}
      >
        + Add Row
      </button>
    </div>
  );
}

const thStyle = {
  padding: "12px",
  textAlign: "left",
  fontSize: "14px",
  color: "#374151",
  borderBottom: "1px solid #e5e7eb"
};

const tdStyle = {
  padding: "10px",
  borderBottom: "1px solid #f3f4f6"
};

const inputStyle = {
  width: "100%",
  padding: "8px",
  borderRadius: "6px",
  border: "1px solid #d1d5db",
  fontSize: "14px"
};
