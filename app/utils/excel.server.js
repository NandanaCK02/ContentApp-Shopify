// app/utils/excel.server.js

import ExcelJS from "exceljs";
import fs from "fs/promises";
import path from "path";

const filePath = path.resolve("public", "collections.xlsx");

export async function generateExcelFile(collections) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Collections");

  worksheet.columns = [
    { header: "ID", key: "id", width: 20 },
    { header: "Title", key: "title", width: 30 },
    { header: "Handle", key: "handle", width: 30 },
    { header: "Rules (JSON)", key: "rules", width: 50 },
  ];

  collections.forEach((collection) => {
    worksheet.addRow({
      id: collection.id,
      title: collection.title,
      handle: collection.handle,
      rules: JSON.stringify(collection.rules),
    });
  });

  await workbook.xlsx.writeFile(filePath);
}

export async function parseExcelFile(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const worksheet = workbook.getWorksheet("Collections");

  const collections = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Skip header
    const [id, title, handle, rules] = row.values.slice(1);
    collections.push({
      id,
      title,
      handle,
      rules: JSON.parse(rules),
    });
  });

  return collections;
}
