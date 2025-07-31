import { json, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useFetcher,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  LegacyStack,
  Text,
  DropZone,
  DataTable,
  Frame,
  Toast,
  List,
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useRevalidator } from "@remix-run/react";

// --- Helper functions for validation (defined once at the top) ---
function isValidJson(str) {
  try {
    JSON.parse(str);
  } catch (e) {
    return false;
  }
  return true;
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch (e) {
    return false;
  }
}

// --- GraphQL Queries and Mutations ---

const GET_ALL_COLLECTIONS_WITH_METAFIELDS_QUERY = `
  query getCollections($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        descriptionHtml
        sortOrder
        templateSuffix
        updatedAt
        image { src }
        metafields(first: 250) {
          nodes {
            id
            namespace
            key
            value
            type
          }
        }
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
    }
  }
`;

const GET_COLLECTION_GIDS_BY_HANDLES_QUERY = `
  query getCollectionGidsByHandles($handles: [String!]!) {
    collections(first: 250, query: $handles.map(handle => "handle:" + handle).join(" OR ")) {
      nodes {
        id
        handle
      }
    }
  }
`;

const COLLECTION_UPDATE_MUTATION = `
  mutation collectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const COLLECTION_CREATE_MUTATION = `
  mutation collectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const SET_METAFIELDS_MUTATION = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
        type
      }
      userErrors { field message }
    }
  }
`;

const GET_COLLECTION_TITLES_QUERY = `
  query getCollectionTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Collection {
        id
        title
      }
    }
  }
`;

// --- Loader ---

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  if (!session || !admin) {
    throw new Response("Unauthorized", { status: 401 });
  }

  let collections = [];
  let cursor = null;
  let hasNextPage = true;

  const allMetafieldDefinitions = new Map();
  const gidsToResolve = new Set(); // Use a Set to store unique GIDs

  try {
    // First pass: Fetch all collections and collect all GIDs from reference metafields
    while (hasNextPage) {
      const response = await admin.graphql(GET_ALL_COLLECTIONS_WITH_METAFIELDS_QUERY, {
        variables: { cursor },
      });
      const data = await response.json();

      if (data.errors) {
        console.error("GraphQL loader errors (GET_ALL_COLLECTIONS_WITH_METAFIELDS):", JSON.stringify(data.errors, null, 2));
        throw new Error(`Failed to fetch collections: ${data.errors.map(e => e.message).join(", ")}`);
      }

      const result = data.data.collections;
      collections.push(...result.nodes);
      hasNextPage = result.pageInfo.hasNextPage;
      cursor = result.pageInfo.endCursor;

      result.nodes.forEach(collection => {
        collection.metafields.nodes.forEach(mf => {
          // Store metafield definition (type and namespace) if not already seen
          // This is crucial for correctly updating metafields later in the action.
          if (!allMetafieldDefinitions.has(mf.key)) {
            allMetafieldDefinitions.set(mf.key, { type: mf.type, namespace: mf.namespace });
          }

          // Collect GIDs for resolution for reference type metafields
          if (mf.type === 'collection_reference' && typeof mf.value === 'string' && mf.value.startsWith("gid://shopify/Collection/")) {
            gidsToResolve.add(mf.value);
          } else if (mf.type === 'list.collection_reference' && typeof mf.value === 'string') {
            try {
              const parsed = JSON.parse(mf.value);
              if (Array.isArray(parsed)) {
                parsed.forEach(gid => {
                  if (typeof gid === 'string' && gid.startsWith("gid://shopify/Collection/")) {
                    gidsToResolve.add(gid);
                  }
                });
              }
            } catch (e) {
              // Ignore parsing errors for GID collection, will be handled during value conversion
            }
          }
        });
      });
    }

    // Second pass: Resolve all collected GIDs in a single (or batched) query
    const resolvedTitlesMap = new Map(); // Store GID -> Title mapping
    const uniqueGidsArray = Array.from(gidsToResolve);

    const BATCH_SIZE = 100; // Adjust based on Shopify's API limits for `nodes` query
    for (let i = 0; i < uniqueGidsArray.length; i += BATCH_SIZE) {
      const batch = uniqueGidsArray.slice(i, i + BATCH_SIZE);
      if (batch.length === 0) continue; // Skip empty batches

      try {
        // Add a small delay between batches to mitigate rate limits if needed
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 50)); // Delay for 50ms between batches
        }

        const response = await admin.graphql(GET_COLLECTION_TITLES_QUERY, {
          variables: { ids: batch },
        });
        const result = await response.json();

        if (result.errors) {
          console.error("GraphQL loader (GET_COLLECTION_TITLES) errors for batch GIDs:", JSON.stringify(result.errors, null, 2));
          // Don't throw, just log and continue, specific metafields will show "Error resolving"
        } else {
          for (const node of result.data.nodes) {
            if (node && node.id && node.title) {
              resolvedTitlesMap.set(node.id, node.title);
            }
          }
        }
      } catch (error) {
        console.error(`Error resolving GID batch (starting at index ${i}):`, error);
        // Continue to next batch even if one fails
      }
    }

    // Third pass: Iterate through collections again to set displayValue using the resolvedTitlesMap
    for (const collection of collections) {
      collection.type = collection.ruleSet ? "Smart" : "Manual";
      collection.exportedRules = collection.ruleSet?.rules || [];

      for (const metafield of collection.metafields.nodes) {
        if (metafield.type === 'list.collection_reference' && typeof metafield.value === 'string') {
          let gids = [];
          try {
            const parsed = JSON.parse(metafield.value);
            if (Array.isArray(parsed)) gids = parsed;
          } catch (e) {
            gids = []; // Invalid JSON
          }
          metafield.displayValue = gids
            .filter(gid => typeof gid === 'string' && gid.startsWith("gid://shopify/Collection/"))
            .map(gid => resolvedTitlesMap.get(gid) || `[Invalid GID: ${gid}]`)
            .join(", ");
        } else if (metafield.type === 'collection_reference' && typeof metafield.value === 'string' && metafield.value.startsWith("gid://shopify/Collection/")) {
          metafield.displayValue = resolvedTitlesMap.get(metafield.value) || `[Invalid GID: ${metafield.value}]`;
        } else {
          metafield.displayValue = metafield.value;
        }
      }
    }
  } catch (error) {
    console.error("Error in collections loader:", error);
    return json({ collections: [], error: error.message || "Failed to load collections." }, { status: 500 });
  }

  // Convert the Map to a plain object for JSON serialization
  return json({ collections, metafieldDefinitions: Object.fromEntries(allMetafieldDefinitions) });
};

// --- Action (Import) ---

function convertValueForShopifyType(value, type) {
  // If the value is truly empty or undefined
  if (value === null || value === undefined || (typeof value === 'string' && String(value).trim() === "")) {
    switch (type) {
      case "json":
        return "{}"; // Send empty JSON object string instead of null
      case "rich_text":
        // Empty rich text is typically an empty blocks array
        return JSON.stringify({ "blocks": [{ "type": "paragraph", "children": [{ "text": "" }] }] });
      case "list.collection_reference":
      case "list.file_reference":
      case "list.image_reference":
      case "list.product_reference":
      case "list.page_reference":
      case "list.url":
        return "[]"; // Send empty JSON array string for lists instead of null
      case "boolean":
        return false; // Default to false if no value is provided
      case "collection_reference":
      case "file_reference":
      case "image_reference":
      case "product_reference":
      case "page_reference":
      case "url":
      case "date":
      case "date_time":
        return ""; // Send empty string for these types when clearing
      default:
        return ""; // For all other types, empty string to clear
    }
  }

  const stringValue = String(value);

  switch (type) {
    case "number_integer":
      const intValue = parseInt(stringValue, 10);
      return isNaN(intValue) ? null : String(intValue);
    case "number_decimal":
      const decimalValue = parseFloat(stringValue);
      return isNaN(decimalValue) ? null : String(decimalValue);
    case "boolean":
      // Handle "Any"/"All" from export, and standard "true"/"false" or "1"/"0"
      if (stringValue.toLowerCase() === "any") return true; // maps "Any" to true
      if (stringValue.toLowerCase() === "all") return false; // maps "All" to false
      return stringValue.toLowerCase() === "true" || stringValue === "1" || stringValue.toLowerCase() === "yes";
    case "json":
    case "dimension":
    case "volume":
    case "weight":
    case "rating":
      // Value must be a string that represents valid JSON
      try {
        JSON.parse(stringValue);
        return stringValue;
      } catch (e) {
        console.warn(`Invalid JSON format for metafield type '${type}': "${stringValue}". Returning empty object string.`);
        return "{}"; // Return empty object string if invalid JSON
      }
    case "rich_text":
      // If it's already valid JSON (likely from a previous export), use it.
      // Otherwise, assume it's plain text and convert to Shopify's rich_text JSON format.
      try {
        JSON.parse(stringValue);
        return stringValue;
      } catch (e) {
        // Fallback for plain text: convert to rich_text JSON format
        return JSON.stringify({
          "blocks": [
            {
              "type": "paragraph",
              "children": [
                { "text": stringValue }
              ]
            }
          ]
        });
      }
    case "date":
      // Excel dates are numbers (days since 1900-01-01). Handle both number and string formats.
      if (typeof value === 'number') {
        const date = new Date(Math.round((value - 25569) * 86400 * 1000)); // Convert Excel serial date to JS Date
        return date.toISOString().split('T')[0]; // Format to YYYY-MM-DD
      }
      // If it's a string, attempt to parse and format
      const dateParse = new Date(stringValue);
      return isNaN(dateParse.getTime()) ? "" : dateParse.toISOString().split('T')[0];
    case "date_time":
      // Excel dates are numbers. Handle both number and string formats.
      if (typeof value === 'number') {
        const dateTime = new Date(Math.round((value - 25569) * 86400 * 1000));
        return dateTime.toISOString(); // Full ISO format
      }
      // If it's a string, attempt to parse and format
      const dateTimeParse = new Date(stringValue);
      return isNaN(dateTimeParse.getTime()) ? "" : dateTimeParse.toISOString();
    case "url":
      if (!isValidUrl(stringValue)) {
        console.warn(`Invalid URL for metafield type 'url': "${stringValue}". Returning empty string.`);
        return ""; // Return empty string for invalid URLs
      }
      return stringValue;
    case "collection_reference":
      // Expects a single GID string, assumed to be resolved already
      return stringValue.startsWith("gid://shopify/Collection/") ? stringValue : "";
    case "list.collection_reference":
      // Expects a JSON array string of GIDs, assumed to be resolved already
      try {
        const parsed = JSON.parse(stringValue);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && item.startsWith("gid://shopify/Collection/"))) {
          return JSON.stringify(parsed);
        }
      } catch (e) {
        console.warn(`Invalid JSON or GID format for list.collection_reference: "${stringValue}". Returning empty array string.`);
      }
      return "[]"; // Return empty array string if invalid JSON or GID format
    case "file_reference":
    case "image_reference":
      // Expects a single GID string
      return stringValue.startsWith("gid://shopify/File/") || stringValue.startsWith("gid://shopify/MediaImage/") ? stringValue : "";
    case "list.file_reference":
    case "list.image_reference":
      // Expects a JSON array string of GIDs
      try {
        const parsed = JSON.parse(stringValue);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && (item.startsWith("gid://shopify/File/") || item.startsWith("gid://shopify/MediaImage/")))) {
          return JSON.stringify(parsed);
        }
      } catch (e) {
        console.warn(`Invalid JSON or GID format for list.file_reference/image_reference: "${stringValue}". Returning empty array string.`);
      }
      return "[]";
    default:
      return stringValue; // For generic text fields, return the string value directly
  }
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  if (!session) {
    return json({ success: false, error: "Authentication required.", status: 401 }, { status: 401 });
  }

  const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 50_000_000 }); // 50 MB
  let formData;
  try {
    formData = await unstable_parseMultipartFormData(request, uploadHandler);
  } catch (error) {
    console.error("Error parsing multipart form data:", error);
    return json({ success: false, error: "Failed to parse file upload. File might be too large or corrupted.", details: error.message }, { status: 400 });
  }

  const file = formData.get("file");

  if (!file || !(file instanceof Blob)) {
    return json({ success: false, error: "No file uploaded or invalid file type. Please upload an Excel (.xlsx) file.", status: 400 }, { status: 400 });
  }

  let workbook;
  let worksheet;
  let headerRowValues;
  const collectionsData = JSON.parse(formData.get("collectionsData"));
  // This map now holds { key: { type, namespace } } for known metafields
  const originalMetafieldDefinitionsMap = collectionsData.metafieldDefinitions || {};
  console.log("Loader-provided Metafield Definitions:", JSON.stringify(originalMetafieldDefinitionsMap, null, 2));


  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    worksheet = workbook.worksheets[0];

    if (!worksheet) {
      return json({ success: false, error: "Excel file is empty or invalid format. No worksheet found.", status: 400 });
    }

    headerRowValues = worksheet.getRow(1).values;
    // ExcelJS `values` returns an array where index 0 is null/undefined and actual values start from index 1.
    // Filter out null/undefined values to get actual headers.
    const filteredHeaderRowValues = headerRowValues.filter(h => h !== null && h !== undefined && String(h).trim() !== '');

    // Expected minimal headers
    if (!filteredHeaderRowValues || filteredHeaderRowValues.length < 7) {
      return json({ success: false, error: "Excel file is missing expected header columns (Collection ID, Title, Description, Sort Order, Template Suffix, Collection Type, Smart Collection: Applied Disjunctively).", status: 400 });
    }

  } catch (error) {
    console.error("Error reading Excel file:", error);
    return json({ success: false, error: `Failed to read Excel file: ${error.message}. Ensure it's a valid .xlsx format.`, status: 400 }, { status: 400 });
  }

  let errors = [];
  let processedRowsCount = 0;
  let updatedCollectionsCount = 0;
  let createdCollectionsCount = 0;
  let updatedMetafieldsCount = 0;

  // Identify column indices dynamically for robustness
  const headerMap = new Map(); // Header Name -> Column Index (1-based from ExcelJS)
  headerRowValues.forEach((h, idx) => {
    if (typeof h === 'string' && h.trim() !== '') {
      headerMap.set(h.trim(), idx);
    }
  });

  const getCellVal = (row, header) => {
    const colIndex = headerMap.get(header);
    return colIndex ? row.getCell(colIndex)?.value : undefined;
  };

  const handlesToResolve = new Set(); // To collect all unique handles for GID lookup

  // Pre-process all rows to collect collection handles from metafields
  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    for (const [header, colIndex] of headerMap.entries()) {
      if (
        ["Collection ID", "Title", "Description", "Sort Order", "Template Suffix", "Collection Type", "Smart Collection: Applied Disjunctively"].includes(header) ||
        /^Rule \d+ - (Column|Relation|Condition)$/.test(header)
      ) {
        continue;
      }

      const rawValue = row.getCell(colIndex)?.value;
      const key = header;
      const existingMetafieldDef = originalMetafieldDefinitionsMap[key];
      const shopifyDefinedType = existingMetafieldDef?.type; // Only proceed if type is explicitly defined

      if (shopifyDefinedType === 'collection_reference' && typeof rawValue === 'string' && String(rawValue).trim() !== '') {
        // Only add if it's not already a GID
        if (!String(rawValue).trim().startsWith("gid://shopify/Collection/")) {
          handlesToResolve.add(String(rawValue).trim());
        }
      } else if (shopifyDefinedType === 'list.collection_reference' && typeof rawValue === 'string' && String(rawValue).trim() !== '') {
        try {
          // If it's a JSON array, parse it and check each item.
          const parsed = JSON.parse(String(rawValue));
          if (Array.isArray(parsed)) {
            parsed.forEach(item => {
              if (typeof item === 'string' && item.trim() !== '' && !item.trim().startsWith("gid://shopify/Collection/")) {
                handlesToResolve.add(item.trim());
              }
            });
          } else {
            // If it's a comma-separated list of handles
            String(rawValue).split(',').map(s => s.trim()).filter(Boolean).forEach(handle => {
              if (!handle.startsWith("gid://shopify/Collection/")) {
                handlesToResolve.add(handle);
              }
            });
          }
        } catch (e) {
          // If not valid JSON, treat as comma-separated or single handle
          String(rawValue).split(',').map(s => s.trim()).filter(Boolean).forEach(handle => {
            if (!handle.startsWith("gid://shopify/Collection/")) {
              handlesToResolve.add(handle);
            }
          });
        }
      }
    }
  }

  const handleToGidMap = new Map();
  const uniqueHandlesArray = Array.from(handlesToResolve);

  // Resolve handles to GIDs
  if (uniqueHandlesArray.length > 0) {
    const BATCH_QUERY_SIZE = 100; // Limit for handles in a single query
    for (let i = 0; i < uniqueHandlesArray.length; i += BATCH_QUERY_SIZE) {
      const batchHandles = uniqueHandlesArray.slice(i, i + BATCH_QUERY_SIZE);
      try {
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 50)); // Delay between batches
        }

        const queryStrings = batchHandles.map(handle => `handle:${JSON.stringify(handle)}`);
        const query = queryStrings.join(" OR ");

        const response = await admin.graphql(`
          query getCollectionGidsByHandles($query: String!) {
            collections(first: 250, query: $query) {
              nodes {
                id
                handle
              }
            }
          }
        `, {
          variables: { query },
        });

        const result = await response.json();
        if (result.errors) {
          console.error(`GraphQL errors resolving handles batch (starting at index ${i}):`, JSON.stringify(result.errors, null, 2));
          // Continue, specific handles will not be resolved
        } else {
          for (const node of result.data.collections.nodes) {
            if (node && node.id && node.handle) {
              handleToGidMap.set(node.handle, node.id);
            }
          }
        }
      } catch (error) {
        console.error(`Error resolving handles batch (starting at index ${i}):`, error);
      }
    }
  }


  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    const id = String(getCellVal(row, "Collection ID") || '').trim();
    const title = String(getCellVal(row, "Title") || '').trim();
    const descriptionHtml = String(getCellVal(row, "Description") || '').trim();
    const sortOrderRaw = getCellVal(row, "Sort Order");
    const templateSuffix = String(getCellVal(row, "Template Suffix") || '').trim() || null;
    const collectionType = String(getCellVal(row, "Collection Type") || '').trim().toLowerCase();
    const appliedDisjunctivelyRaw = getCellVal(row, "Smart Collection: Applied Disjunctively");

    console.log(`\n--- Processing Row ${rowIndex} ---`);
    console.log(`Collection ID from Excel: "${id}", Title from Excel: "${title}"`);

    // Determine if it's an update or create operation
    const isUpdate = id && id.startsWith("gid://shopify/Collection/");
    let mutationType = isUpdate ? "update" : "create";
    console.log(`Determined operation type: "${mutationType}".`);

    // Validate Collection ID for update operations
    if (!isUpdate && !title) {
        errors.push({ row: rowIndex, message: "Skipping row: Collection ID is missing or invalid, and Title is empty. Cannot create or update collection." });
        console.error(`Row ${rowIndex}: Skipping. Collection ID is invalid for update and title is empty for new creation.`);
        continue;
    }
    if (isUpdate && !id.startsWith("gid://shopify/Collection/")) {
      errors.push({
        row: rowIndex,
        message: `Invalid Collection ID in Column 'Collection ID'. Expected format: 'gid://shopify/Collection/12345'. Found: "${id || 'EMPTY'}". Skipping update for this row.`
      });
      console.error(`Row ${rowIndex}: Invalid Collection ID found for update: "${id}"`);
      continue;
    }

    const collectionInput = {
      title,
      descriptionHtml,
    };

    if (sortOrderRaw) {
      const sortOrder = String(sortOrderRaw).toUpperCase().trim();
      const validSortOrders = ['ALPHA_ASC', 'ALPHA_DESC', 'BEST_SELLING', 'CREATED', 'MANUAL', 'PRICE_ASC', 'PRICE_DESC'];
      if (validSortOrders.includes(sortOrder)) {
        collectionInput.sortOrder = sortOrder;
      } else {
        errors.push({ row: rowIndex, message: `Invalid Sort Order value: "${sortOrderRaw}". Must be one of: ${validSortOrders.join(", ")}. Skipping sortOrder update.` });
        console.warn(`Row ${rowIndex}: Invalid Sort Order: "${sortOrderRaw}"`);
      }
    }

    collectionInput.templateSuffix = templateSuffix;

    // --- Smart Collection RuleSet Handling ---
    if (collectionType === 'smart') {
      const rules = [];
      let ruleIndex = 1;
      while (headerMap.has(`Rule ${ruleIndex} - Column`)) {
        const column = String(getCellVal(row, `Rule ${ruleIndex} - Column`) || '').trim();
        const relation = String(getCellVal(row, `Rule ${ruleIndex} - Relation`) || '').trim();
        const condition = getCellVal(row, `Rule ${ruleIndex} - Condition`);

        if (column && relation && condition !== undefined && String(condition).trim() !== '') {
          rules.push({ column, relation, condition: String(condition) });
        } else if (column || relation || (condition !== undefined && String(condition).trim() !== '')) {
          errors.push({
            row: rowIndex,
            message: `Incomplete rule ${ruleIndex} for smart collection. All of 'Column', 'Relation', 'Condition' must be present and non-empty for rule ${ruleIndex}.`
          });
          console.warn(`Row ${rowIndex}: Incomplete rule ${ruleIndex}.`);
        }
        ruleIndex++;
      }

      if (rules.length > 0) {
        const appliedDisjunctivelyBoolean = String(appliedDisjunctivelyRaw || '').toLowerCase() === 'any';
        collectionInput.ruleSet = {
          appliedDisjunctively: appliedDisjunctivelyBoolean,
          rules: rules,
        };
        console.log(`Row ${rowIndex}: Smart collection rules processed: ${rules.length} rules, Applied Disjunctively: ${appliedDisjunctivelyBoolean}.`);
      } else {
        errors.push({
          row: rowIndex,
          message: `Collection type is 'Smart' but no valid rules were found. Smart collections require at least one rule. This collection will be treated as Manual.`
        });
        collectionInput.ruleSet = null; // Ensure ruleSet is null for Manual
        console.warn(`Row ${rowIndex}: Smart collection declared but no valid rules found. Setting as Manual.`);
      }
    } else {
      collectionInput.ruleSet = null; // Explicitly set ruleSet to null for Manual collections
      console.log(`Row ${rowIndex}: Collection type is 'Manual'. RuleSet set to null.`);
    }

    // --- Perform Collection Update or Create ---
    let targetCollectionId = id; // This will hold the GID of the collection to update metafields on

    try {
      let mutationResponse;
      let mutationResult;

      if (isUpdate) {
        const updateInput = { ...collectionInput, id: id };
        console.log(`Row ${rowIndex}: Attempting to UPDATE existing collection with ID: ${id}. Input:`, JSON.stringify(updateInput, null, 2));
        mutationResponse = await admin.graphql(COLLECTION_UPDATE_MUTATION, {
          variables: { input: updateInput },
        });
        mutationResult = await mutationResponse.json();

        if (mutationResult.data?.collectionUpdate?.userErrors?.length > 0) {
          const userErrors = mutationResult.data.collectionUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join("; ");
          errors.push({
            row: rowIndex,
            message: `Collection update errors: ${userErrors}`,
          });
          console.error(`Row ${rowIndex}: Collection update user errors: ${userErrors}`);
          targetCollectionId = null; // Mark as failed to prevent metafield update
        } else if (mutationResult.errors) {
          const graphQLErrors = JSON.stringify(mutationResult.errors.map(e => e.message).join(", "));
          errors.push({
            row: rowIndex,
            message: `Collection update GraphQL errors: ${graphQLErrors}`,
          });
          console.error(`Row ${rowIndex}: Collection update GraphQL errors: ${graphQLErrors}`);
          targetCollectionId = null;
        } else {
          updatedCollectionsCount++;
          console.log(`Row ${rowIndex}: Successfully updated collection ID: ${id}`);
          targetCollectionId = mutationResult.data.collectionUpdate.collection.id; // Confirm ID
        }
      } else { // Create
        console.log(`Row ${rowIndex}: Attempting to CREATE new collection. Input:`, JSON.stringify(collectionInput, null, 2));
        mutationResponse = await admin.graphql(COLLECTION_CREATE_MUTATION, {
          variables: { input: collectionInput },
        });
        mutationResult = await mutationResponse.json();

        if (mutationResult.data?.collectionCreate?.userErrors?.length > 0) {
          const userErrors = mutationResult.data.collectionCreate.userErrors.map(e => `${e.field}: ${e.message}`).join("; ");
          errors.push({
            row: rowIndex,
            message: `Collection creation errors: ${userErrors}`,
          });
          console.error(`Row ${rowIndex}: Collection creation user errors: ${userErrors}`);
          targetCollectionId = null;
        } else if (mutationResult.errors) {
          const graphQLErrors = JSON.stringify(mutationResult.errors.map(e => e.message).join(", "));
          errors.push({
            row: rowIndex,
            message: `Collection creation GraphQL errors: ${graphQLErrors}`,
          });
          console.error(`Row ${rowIndex}: Collection creation GraphQL errors: ${graphQLErrors}`);
          targetCollectionId = null;
        } else {
          createdCollectionsCount++;
          const newCollectionId = mutationResult.data.collectionCreate.collection.id;
          if (newCollectionId) {
            targetCollectionId = newCollectionId; // Crucial: use the newly created ID for metafields
            console.log(`Row ${rowIndex}: Successfully created new collection, ID: ${newCollectionId}`);
          } else {
            errors.push({ row: rowIndex, message: `Collection created but no ID returned.` });
            console.error(`Row ${rowIndex}: Collection created but no ID returned.`);
            targetCollectionId = null;
          }
        }
      }

    } catch (e) {
      console.error(`Error ${mutationType} collection "${title}" (row ${rowIndex}):`, e);
      errors.push({ row: rowIndex, message: `Collection ${mutationType} failed for "${title}": ${e.message}` });
      targetCollectionId = null; // Mark as failed
      continue; // Skip metafield update if collection failed to create/update
    }


    // --- Metafields Update ---
    if (!targetCollectionId) {
      errors.push({ row: rowIndex, message: `Skipping metafield updates for "${title}" as collection ID is not available after collection operation.` });
      console.error(`Row ${rowIndex}: Skipping metafield updates. targetCollectionId is missing.`);
      continue;
    }
    console.log(`Row ${rowIndex}: Collection successfully ${mutationType}d, actual ID to use for metafields: ${targetCollectionId}. Preparing metafields.`);


    const metafieldsToSet = [];
    for (const [header, colIndex] of headerMap.entries()) {
      // Skip standard columns (Collection ID, Title, etc.)
      if (
        ["Collection ID", "Title", "Description", "Sort Order", "Template Suffix", "Collection Type", "Smart Collection: Applied Disjunctively"].includes(header) ||
        /^Rule \d+ - (Column|Relation|Condition)$/.test(header)
      ) {
        continue;
      }

      const rawValue = row.getCell(colIndex)?.value;
      const key = header;

      // Determine the metafield's defined type and namespace from loader data
      const existingMetafieldDef = originalMetafieldDefinitionsMap[key];
      // Default to single_line_text_field if no definition is found in the loader data,
      // and 'custom' namespace. This is the fallback for new metafields or unknown ones.
      const shopifyDefinedType = existingMetafieldDef?.type || "single_line_text_field";
      const metafieldNamespace = existingMetafieldDef?.namespace || "custom";

      console.log(`  Row ${rowIndex}, Metafield: "${key}". Raw Value: "${rawValue}"`);
      console.log(`  Expected Type (from loader): "${existingMetafieldDef?.type || 'N/A'}", Expected Namespace (from loader): "${existingMetafieldDef?.namespace || 'N/A'}"`);
      console.log(`  Actual Type used for API: "${shopifyDefinedType}", Actual Namespace used for API: "${metafieldNamespace}"`);

      if (!existingMetafieldDef) {
        console.warn(`  WARNING: Row ${rowIndex}, Metafield "${key}": No existing metafield definition found in loader data for this key. Defaulting to type: "${shopifyDefinedType}", namespace: "${metafieldNamespace}". This might cause issues if a different type/namespace is intended for an existing metafield.`);
      }

      let valueToConvert = rawValue;

      // Perform handle-to-GID conversion for collection references
      if (shopifyDefinedType === 'collection_reference' && typeof rawValue === 'string' && String(rawValue).trim() !== '') {
        const handle = String(rawValue).trim();
        if (!handle.startsWith("gid://shopify/Collection/")) {
          const resolvedGid = handleToGidMap.get(handle);
          if (resolvedGid) {
            valueToConvert = resolvedGid;
            console.log(`  Row ${rowIndex}, Metafield "${key}": Resolved handle "${handle}" to GID "${resolvedGid}".`);
          } else {
            errors.push({ row: rowIndex, message: `Metafield '${key}' (type: ${shopifyDefinedType}): Could not resolve collection handle "${handle}" to a GID. Skipping this metafield.` });
            console.warn(`  Row ${rowIndex}, Metafield "${key}": Could not resolve collection handle "${handle}" to a GID.`);
            continue; // Skip this metafield if handle not resolved
          }
        } else {
          console.log(`  Row ${rowIndex}, Metafield "${key}": Value "${handle}" is already a GID.`);
        }
      } else if (shopifyDefinedType === 'list.collection_reference' && typeof rawValue === 'string' && String(rawValue).trim() !== '') {
        let handles = [];
        try {
          const parsed = JSON.parse(String(rawValue)); // Try parsing as JSON array first
          if (Array.isArray(parsed)) {
            handles = parsed.map(String).filter(Boolean).map(h => h.trim());
            console.log(`  Row ${rowIndex}, Metafield "${key}": Parsed value as JSON array: ${JSON.stringify(handles)}`);
          } else {
            // If not JSON array, assume comma-separated
            handles = String(rawValue).split(',').map(s => s.trim()).filter(Boolean);
            console.log(`  Row ${rowIndex}, Metafield "${key}": Parsed value as comma-separated handles: ${JSON.stringify(handles)}`);
          }
        } catch (e) {
          // If JSON parsing fails, treat as comma-separated
          handles = String(rawValue).split(',').map(s => s.trim()).filter(Boolean);
          console.log(`  Row ${rowIndex}, Metafield "${key}": JSON parse failed, treating as comma-separated handles: ${JSON.stringify(handles)}`);
        }

        const resolvedGids = [];
        let allHandlesResolved = true;
        for (const handle of handles) {
          if (handle.startsWith("gid://shopify/Collection/")) {
            resolvedGids.push(handle);
            console.log(`  Row ${rowIndex}, Metafield "${key}": List item "${handle}" is already a GID.`);
          } else {
            const resolvedGid = handleToGidMap.get(handle);
            if (resolvedGid) {
              resolvedGids.push(resolvedGid);
              console.log(`  Row ${rowIndex}, Metafield "${key}": Resolved list handle "${handle}" to GID "${resolvedGid}".`);
            } else {
              errors.push({ row: rowIndex, message: `Metafield '${key}' (type: ${shopifyDefinedType}): Could not resolve collection handle "${handle}" to a GID. This list item will be skipped.` });
              console.warn(`  Row ${rowIndex}, Metafield "${key}": Could not resolve list handle "${handle}" to a GID.`);
              allHandlesResolved = false;
            }
          }
        }
        if (allHandlesResolved) {
          valueToConvert = JSON.stringify(resolvedGids);
          console.log(`  Row ${rowIndex}, Metafield "${key}": Final value for API (list): "${valueToConvert}"`);
        } else {
          console.warn(`  Row ${rowIndex}, Metafield "${key}": Skipping this list metafield as not all handles could be resolved.`);
          continue; // Skip this metafield if any handle in the list could not be resolved
        }
      }

      const valueForApi = convertValueForShopifyType(valueToConvert, shopifyDefinedType);
      console.log(`  Row ${rowIndex}, Metafield "${key}": Converted value for API: "${valueForApi}" (type: ${typeof valueForApi})`);

      // Add to metafieldsToSet only if valueForApi is not undefined (it means conversion was attempted)
      // `null` for valueForApi is intended to clear a metafield
      if (valueForApi !== undefined) {
        metafieldsToSet.push({
          ownerId: targetCollectionId,
          namespace: metafieldNamespace,
          key: key,
          type: shopifyDefinedType,
          value: valueForApi !== null ? String(valueForApi) : null, // Ensure value is string or null
        });
      }
    }

    if (metafieldsToSet.length > 0) {
      try {
        console.log(`Attempting to set ${metafieldsToSet.length} metafield(s) for collection ID: ${targetCollectionId} (Row ${rowIndex})`);
        console.log("Metafields payload:", JSON.stringify(metafieldsToSet, null, 2));

        const metafieldResponse = await admin.graphql(SET_METAFIELDS_MUTATION, {
          variables: { metafields: metafieldsToSet },
        });
        const metafieldResult = await metafieldResponse.json();

        if (metafieldResult.errors) {
          const graphQLErrors = JSON.stringify(metafieldResult.errors.map(e => e.message).join(", "));
          console.error(`Metafield update GraphQL errors for row ${rowIndex}:`, graphQLErrors);
          errors.push({
            row: rowIndex,
            message: `Metafield update GraphQL errors: ${graphQLErrors}`
          });
        } else if (metafieldResult.data?.metafieldsSet?.userErrors?.length) {
          const userErrors = metafieldResult.data.metafieldsSet.userErrors.map(e => `${e.field}: ${e.message}`).join("; ");
          console.error(`Metafield update user errors for row ${rowIndex}:`, userErrors);
          errors.push({
            row: rowIndex,
            message: `Metafield update user errors: ${userErrors}`,
          });
        } else if (metafieldResult.data?.metafieldsSet?.metafields?.length) {
          updatedMetafieldsCount += metafieldResult.data.metafieldsSet.metafields.length;
          console.log(`Successfully updated ${metafieldResult.data.metafieldsSet.metafields.length} metafields for collection ${targetCollectionId} (Row ${rowIndex}).`);
        } else {
            console.log(`No metafields explicitly returned as updated for collection ${targetCollectionId} (Row ${rowIndex}). This might mean no changes or an empty result.`);
        }
      } catch (e) {
        console.error(`Network or unexpected error updating metafields for collection ${targetCollectionId} (row ${rowIndex}):`, e);
        errors.push({ row: rowIndex, message: `Metafield update failed for ID ${targetCollectionId}: ${e.message}` });
      }
    } else {
        console.log(`No metafields to set for collection ${targetCollectionId} (Row ${rowIndex}).`);
    }
    processedRowsCount++;
  }

  let summaryMessage = `Import process completed.`;
  let isSuccess = errors.length === 0;

  if (isSuccess) {
    summaryMessage += ` All ${processedRowsCount} rows processed. ${createdCollectionsCount} collections created and ${updatedCollectionsCount} updated. ${updatedMetafieldsCount} metafields set successfully.`;
  } else {
    summaryMessage += ` ${createdCollectionsCount} collections created, ${updatedCollectionsCount} updated, ${updatedMetafieldsCount} metafields set. However, ${errors.length} row(s) had errors.`;
  }

  return json({
    success: isSuccess,
    message: summaryMessage,
    errors,
    processedRowsCount,
    updatedCollectionsCount,
    createdCollectionsCount,
    updatedMetafieldsCount,
    importedFileName: file.name,
  }, { status: isSuccess ? 200 : 400 });
};


export default function Collections() {
  const { collections, error: loaderError, metafieldDefinitions } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [fileName, setFileName] = useState("");
  const [toastActive, setToastActive] = useState(false);
  const [toastContent, setToastContent] = useState("");
  const [toastError, setToastError] = useState(false);
  const [importErrors, setImportErrors] = useState([]);

  useEffect(() => {
    if (loaderError) {
      setToastContent(`Error loading collections: ${loaderError}`);
      setToastError(true);
      setToastActive(true);
    }
  }, [loaderError]);

  // Handle action data from import
  useEffect(() => {
    if (fetcher.state === "idle" && actionData) {
      if (actionData.success) {
        setToastContent(actionData.message || "Import completed successfully.");
        setToastError(false);
        setToastActive(true);
        setFileName(""); // Clear file name on success
        setImportErrors([]); // Clear any previous errors

        // Revalidate loader data to show updated collections
        revalidator.revalidate();
      } else {
        setToastContent(actionData.message || "Import failed with errors.");
        setToastError(true);
        setToastActive(true);
        if (actionData.errors) {
          setImportErrors(actionData.errors);
        }
      }
    }
    // Handle toast for submitting state
    if (fetcher.state === "submitting" && fileName) {
      setToastContent(`Importing "${fileName}"... Please wait, this may take a moment.`);
      setToastError(false);
      setToastActive(true);
      setImportErrors([]);
    }
  }, [fetcher.state, actionData, fileName, revalidator]);

  const toggleToastActive = useCallback(() => setToastActive((active) => !active), []);

  const handleDownload = useCallback(async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Collections");

    const uniqueMetafields = new Map();
    collections.forEach(col => {
      col.metafields.nodes.forEach(mf => {
        if (!uniqueMetafields.has(mf.key)) {
          // Store namespace for export to ensure it's re-used on import
          uniqueMetafields.set(mf.key, { key: mf.key, type: mf.type, namespace: mf.namespace });
        }
      });
    });

    // Patterns for smart collection rule headers (to filter out from generic metafields)
    const ruleKeyPatternDash = /^Rule \d+ - (Column|Relation|Condition)$/;
    const ruleKeyPatternColon = /^Rule \d+: (Column|Condition|Relation)$/; // For metafields that might be named like rules

    const metafieldKeysAndTypes = Array.from(uniqueMetafields.values())
        .filter(mt => !ruleKeyPatternDash.test(mt.key) && !ruleKeyPatternColon.test(mt.key)) // Exclude rule-like keys from metafields
        .sort((a, b) => a.key.localeCompare(b.key));

    const metafieldHeaders = metafieldKeysAndTypes.map(mt => mt.key);

    // Determine max number of rules for any smart collection
    let maxRules = 0;
    collections.forEach(col => {
      // Use ruleSet?.rules directly, as exportedRules is just a convenient alias
      if (col.type === "Smart" && col.ruleSet?.rules?.length > maxRules) {
        maxRules = col.ruleSet.rules.length;
      }
    });

    const ruleHeaders = [];
    for (let i = 1; i <= maxRules; i++) {
      ruleHeaders.push(`Rule ${i} - Column`, `Rule ${i} - Relation`, `Rule ${i} - Condition`);
    }

    const headers = [
      "Collection ID",
      "Title",
      "Description",
      "Sort Order",
      "Template Suffix",
      "Collection Type", // Manual or Smart
      "Smart Collection: Applied Disjunctively", // This header will contain "Any" or "All"
      ...ruleHeaders, // Dynamic rule headers
      ...metafieldHeaders, // Now filtered to exclude rule-like keys
    ];
    worksheet.addRow(headers);

    // Create a map from GID to handle for efficient lookup during export
    const gidToHandleMap = new Map();
    collections.forEach(col => {
      gidToHandleMap.set(col.id, col.handle);
    });

    collections.forEach(col => {
      const metafieldMap = {};
      col.metafields.nodes.forEach(mf => {
        // When exporting, prioritize handle for reference types if available, otherwise GID.
        if (mf.type === 'collection_reference') {
          metafieldMap[mf.key] = gidToHandleMap.get(mf.value) || mf.value || "";
        } else if (mf.type === 'list.collection_reference' && mf.value) {
          try {
              const gids = JSON.parse(mf.value);
              if (Array.isArray(gids)) {
                  const handles = gids.map(gid => {
                      return gidToHandleMap.get(gid) || gid; // Prioritize handle, fallback to GID
                  }).filter(Boolean); // Remove any null/undefined
                  metafieldMap[mf.key] = JSON.stringify(handles); // Export as JSON array of handles
              } else {
                  metafieldMap[mf.key] = mf.value; // Fallback to raw value if not an array
              }
          } catch (e) {
              metafieldMap[mf.key] = mf.value; // Fallback to raw value if invalid JSON
          }
        } else if (mf.type.endsWith('_reference') || mf.type.startsWith('list.')) {
          metafieldMap[mf.key] = mf.value || ""; // Export the raw value (GID or JSON array of GIDs)
        } else {
          metafieldMap[mf.key] = mf.displayValue || mf.value || "";
        }
      });

      const ruleData = [];
      // Ensure we use the actual rules from ruleSet, not just exportedRules for consistency
      const currentRules = col.ruleSet?.rules || [];
      currentRules.forEach(rule => {
        ruleData.push(rule.column, rule.relation, rule.condition);
      });
      // Pad with empty strings if fewer rules than maxRules
      while (ruleData.length < maxRules * 3) {
        ruleData.push("", "", "");
      }

      // Convert boolean to "Any" or "All" for export (as requested)
      const appliedDisjunctivelyDisplay = col.type === "Smart"
        ? (col.ruleSet?.appliedDisjunctively ? "Any" : "All")
        : "";

      const rowData = [
        col.id,
        col.title,
        col.descriptionHtml,
        col.sortOrder || "",
        col.templateSuffix || "",
        col.type,
        appliedDisjunctivelyDisplay,
        ...ruleData,
        ...metafieldHeaders.map(key => metafieldMap[key] || ""), // Map based on filtered headers
      ];
      worksheet.addRow(rowData);
    });

    const buffer = await workbook.xlsx.writeBuffer();

    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shopify_collections_export.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, [collections]);

  const handleDrop = useCallback((files, acceptedFiles) => {
    if (acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      const formData = new FormData();
      formData.append("file", selectedFile);
      // Pass the known metafield definitions (including namespaces) from the loader to the action
      formData.append("collectionsData", JSON.stringify({ metafieldDefinitions }));

      setFileName(selectedFile.name);
      setImportErrors([]); // Clear errors when a new file is dropped
      fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
    }
  }, [fetcher, metafieldDefinitions]);

  // This is where `rows` are constructed for the DataTable shown in the UI.
  // This already provides a summary and avoids showing individual rule columns twice.
  const rows = collections.map((collection) => {
    // Generate a summary for Smart Logic column
    const smartLogicSummary = collection.type === "Smart"
      ? (collection.ruleSet?.appliedDisjunctively ? "Match any conditions" : "Match all conditions") +
        (collection.ruleSet?.rules?.length > 0
          ? ` (${collection.ruleSet.rules.length} rule${collection.ruleSet.rules.length > 1 ? 's' : ''})`
          : " (No rules defined)")
      : "N/A";

    return [
      collection.title,
      collection.handle,
      collection.type,
      smartLogicSummary,
      collection.metafields.nodes.length,
      new Date(collection.updatedAt).toLocaleString(),
    ];
  });

  return (
    <Page>
      <TitleBar title="Collections Export/Import" />
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <LegacyStack spacing="tight" vertical>
              <Text variant="headingMd" as="h2">Export Collections to Excel</Text>
              <Text variant="bodyMd" as="p">Download all your Shopify collections, including their core fields, smart collection rules, and custom metafields, into an Excel file. This file can then be updated and re-imported.</Text>
              <Button onClick={handleDownload} primary disabled={navigation.state !== "idle" || collections.length === 0}>
                {navigation.state !== "idle" ? <Spinner size="small" /> : `Export Collections (${collections.length} total)`}
              </Button>
            </LegacyStack>
          </Card>

          <Card sectioned title="Import Updated Excel File">
            <LegacyStack spacing="tight" vertical>
              <Text variant="bodyMd" as="p">
                Upload an Excel file (preferably one exported from this app) to update existing collections and their metafields.
                <br />
                <List type="bullet">
                  <List.Item>
                    **Collection ID (Column A):** Leave empty for new collections, use existing GID for updates. **Crucial:** Ensure this is the correct Shopify GID for existing collections.
                  </List.Item>
                  <List.Item>
                    **Collection Type:** Enter "Manual" or "Smart".
                  </List.Item>
                  <List.Item>
                    **Smart Collection: Applied Disjunctively:** Enter "Any" (for product must match any condition) or "All" (for product must match all conditions).
                  </List.Item>
                  <List.Item>
                    **Smart Collection Rules:** For "Smart" collections, use `Rule X - Column`, `Rule X - Relation`, `Rule X - Condition` columns to define each rule. Each rule requires all three parts.
                  </List.Item>
                  <List.Item>
                    **Metafields:** Custom metafields start after the standard and rule columns. The header should be the metafield's `key`.
                  </List.Item>
                  <List.Item>
                    **Reference Types (`collection_reference`, `list.collection_reference`, etc.):** For single references, you can use either the raw Shopify GID or the collection handle. For list types, a comma-separated list of handles or a valid JSON array string of GIDs (e.g., `["gid://...","gid://..."]`) or handles (e.g., `["handle1","handle2"]`).
                  </List.Item>
                </List>
              </Text>
              <DropZone allowMultiple={false} onDrop={handleDrop} disabled={fetcher.state !== "idle"} accept=".xlsx">
                {fileName ? <Text alignment="center">Selected file: {fileName}</Text> : <DropZone.FileUpload actionHint="Accepts .xlsx files only" />}
              </DropZone>
              {fetcher.state !== "idle" && <Text alignment="center" variant="bodyMd"><Spinner size="small" /> Processing import... This may take a moment.</Text>}
            </LegacyStack>
          </Card>

          {importErrors.length > 0 && (
            <Layout.Section>
              <Card sectioned title="Import Errors Detected">
                <LegacyStack vertical spacing="tight">
                  <Text color="critical" variant="headingSm">The following issues were found during the import:</Text>
                  <DataTable
                    columnContentTypes={["text", "text"]}
                    headings={["Row #", "Error Message"]}
                    rows={importErrors.map(err => [err.row || 'N/A', err.message])}
                  />
                  <Text>Please correct these issues in your Excel file and try re-importing.</Text>
                </LegacyStack>
              </Card>
            </Layout.Section>
          )}
        </Layout.Section>

        {collections.length > 0 && (
          <Layout.Section>
            <Card title={`Existing Collections (${collections.length})`} sectioned>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "numeric", "text"]}
                headings={["Title", "Handle", "Type", "Smart Logic", "Metafields Count", "Updated At"]}
                rows={rows}
              />
            </Card>
          </Layout.Section>
        )}
      </Layout>

      {toastActive && (
        <Frame>
          <Toast content={toastContent} error={toastError} onDismiss={toggleToastActive} duration={5000} />
        </Frame>
      )}
    </Page>
  );
}