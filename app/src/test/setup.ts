/**
 * Vitest setup: jest-dom matchers (toBeInTheDocument, ...) and an in-memory
 * IndexedDB so Dexie works inside jsdom.
 */
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
