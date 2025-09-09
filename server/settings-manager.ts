import { z } from "zod";

// Define the settings schema
export const SettingsSchema = z.object({
  validation: z.object({
    fuzzyMatchThresholds: z.object({
      high: z.number().min(0).max(100).default(90),
      medium: z.number().min(0).max(100).default(70),
      low: z.number().min(0).max(100).default(50),
    }),
    enabledAlgorithms: z.object({
      levenshtein: z.boolean().default(true),
      jaccard: z.boolean().default(true),
      wordLevel: z.boolean().default(true),
    }),
    maxSuggestions: z.number().min(1).max(10).default(5),
    minWordLength: z.number().min(1).max(10).default(2),
  }),
  processing: z.object({
    maxFileSize: z.number().min(1024).max(100 * 1024 * 1024).default(10 * 1024 * 1024), // 10MB default
    allowedFileTypes: z.array(z.string()).default(['.xlsx', '.xls']),
    batchSize: z.number().min(1).max(1000).default(100),
    enableParallelProcessing: z.boolean().default(true),
  }),
  xero: z.object({
    timeout: z.number().min(5000).max(60000).default(30000), // 30 seconds
    retryAttempts: z.number().min(1).max(5).default(3),
    rateLimitDelay: z.number().min(100).max(5000).default(1000),
    enableBatchUpload: z.boolean().default(true),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    enableConsoleLogging: z.boolean().default(true),
    enableFileLogging: z.boolean().default(false),
    maxLogFiles: z.number().min(1).max(100).default(10),
  }),
  ui: z.object({
    enableDarkMode: z.boolean().default(false),
    showAdvancedOptions: z.boolean().default(false),
    enableAnimations: z.boolean().default(true),
    compactMode: z.boolean().default(false),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;

// Default settings
export const DefaultSettings: Settings = {
  validation: {
    fuzzyMatchThresholds: { high: 90, medium: 70, low: 50 },
    enabledAlgorithms: { levenshtein: true, jaccard: true, wordLevel: true },
    maxSuggestions: 5,
    minWordLength: 2,
  },
  processing: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    allowedFileTypes: ['.xlsx', '.xls'],
    batchSize: 100,
    enableParallelProcessing: true,
  },
  xero: {
    timeout: 30000,
    retryAttempts: 3,
    rateLimitDelay: 1000,
    enableBatchUpload: true,
  },
  logging: {
    level: 'info',
    enableConsoleLogging: true,
    enableFileLogging: false,
    maxLogFiles: 10,
  },
  ui: {
    enableDarkMode: false,
    showAdvancedOptions: false,
    enableAnimations: true,
    compactMode: false,
  },
};

/**
 * Centralized Settings Manager
 * Provides configuration management with validation, persistence, and import/export capabilities
 */
class SettingsManager {
  private settings: Settings;
  private readonly storageKey = 'timesheet_app_settings';
  private readonly settingsFile = 'settings.json';

  constructor() {
    this.settings = { ...DefaultSettings };
    this.loadSettings();
  }

  /**
   * Get current settings
   */
  getSettings(): Settings {
    return { ...this.settings };
  }

  /**
   * Get a specific setting by path
   */
  getSetting<T>(path: string): T | undefined {
    return this.getNestedValue(this.settings, path) as T;
  }

  /**
   * Update specific setting
   */
  updateSetting(path: string, value: any): boolean {
    try {
      const newSettings = { ...this.settings };
      this.setNestedValue(newSettings, path, value);
      
      // Validate the updated settings
      const validationResult = SettingsSchema.safeParse(newSettings);
      if (!validationResult.success) {
        console.error('Settings validation failed:', validationResult.error);
        return false;
      }

      this.settings = validationResult.data;
      this.saveSettings();
      return true;
    } catch (error) {
      console.error('Failed to update setting:', error);
      return false;
    }
  }

  /**
   * Update multiple settings at once
   */
  updateSettings(partialSettings: Partial<Settings>): boolean {
    try {
      const newSettings = this.mergeDeep(this.settings, partialSettings);
      
      // Validate the updated settings
      const validationResult = SettingsSchema.safeParse(newSettings);
      if (!validationResult.success) {
        console.error('Settings validation failed:', validationResult.error);
        return false;
      }

      this.settings = validationResult.data;
      this.saveSettings();
      return true;
    } catch (error) {
      console.error('Failed to update settings:', error);
      return false;
    }
  }

  /**
   * Reset settings to defaults
   */
  resetSettings(): void {
    this.settings = { ...DefaultSettings };
    this.saveSettings();
  }

  /**
   * Export settings to JSON string
   */
  exportSettings(): string {
    return JSON.stringify(this.settings, null, 2);
  }

  /**
   * Import settings from JSON string
   */
  importSettings(jsonString: string): boolean {
    try {
      const importedSettings = JSON.parse(jsonString);
      const validationResult = SettingsSchema.safeParse(importedSettings);
      
      if (!validationResult.success) {
        console.error('Invalid settings format:', validationResult.error);
        return false;
      }

      this.settings = validationResult.data;
      this.saveSettings();
      return true;
    } catch (error) {
      console.error('Failed to import settings:', error);
      return false;
    }
  }

  /**
   * Get validation thresholds for fuzzy matching
   */
  getValidationThresholds() {
    return this.settings.validation.fuzzyMatchThresholds;
  }

  /**
   * Get enabled matching algorithms
   */
  getEnabledAlgorithms() {
    return this.settings.validation.enabledAlgorithms;
  }

  /**
   * Get processing configuration
   */
  getProcessingConfig() {
    return this.settings.processing;
  }

  /**
   * Get Xero API configuration
   */
  getXeroConfig() {
    return this.settings.xero;
  }

  /**
   * Get logging configuration
   */
  getLoggingConfig() {
    return this.settings.logging;
  }

  /**
   * Get UI configuration
   */
  getUIConfig() {
    return this.settings.ui;
  }

  /**
   * Check if a feature is enabled
   */
  isFeatureEnabled(feature: string): boolean {
    switch (feature) {
      case 'parallelProcessing':
        return this.settings.processing.enableParallelProcessing;
      case 'batchUpload':
        return this.settings.xero.enableBatchUpload;
      case 'darkMode':
        return this.settings.ui.enableDarkMode;
      case 'animations':
        return this.settings.ui.enableAnimations;
      default:
        return false;
    }
  }

  /**
   * Load settings from storage
   */
  private loadSettings(): void {
    try {
      // Try to load from environment/file first
      if (process.env.SETTINGS_JSON) {
        const envSettings = JSON.parse(process.env.SETTINGS_JSON);
        const validationResult = SettingsSchema.safeParse(envSettings);
        if (validationResult.success) {
          this.settings = validationResult.data;
          return;
        }
      }

      // Fallback to in-memory storage (for development)
      // In production, this could load from a database or file system
      console.log('Using default settings configuration');
    } catch (error) {
      console.warn('Failed to load settings, using defaults:', error);
    }
  }

  /**
   * Save settings to storage
   */
  private saveSettings(): void {
    try {
      // In a real application, this would save to a database or file system
      // For now, we just validate and keep in memory
      console.log('Settings updated and validated successfully');
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Set nested value in object using dot notation
   */
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => {
      if (!(key in current)) current[key] = {};
      return current[key];
    }, obj);
    target[lastKey] = value;
  }

  /**
   * Deep merge two objects
   */
  private mergeDeep(target: any, source: any): any {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.mergeDeep(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }
}

// Create and export singleton instance
export const settingsManager = new SettingsManager();

// Helper functions for common operations
export const getValidationThresholds = () => settingsManager.getValidationThresholds();
export const getEnabledAlgorithms = () => settingsManager.getEnabledAlgorithms();
export const getProcessingConfig = () => settingsManager.getProcessingConfig();
export const getXeroConfig = () => settingsManager.getXeroConfig();
export const isFeatureEnabled = (feature: string) => settingsManager.isFeatureEnabled(feature);