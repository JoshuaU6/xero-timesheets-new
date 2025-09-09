/**
 * Comprehensive Validation System for Timesheet Processing
 * 
 * Improvements over basic validation:
 * - Structured ValidationResult classes
 * - Fuzzy matching with confidence levels
 * - Better error reporting with suggestions
 * - Region validation against Xero tracking categories
 * - Enhanced employee matching
 */

import { getValidationThresholds, getEnabledAlgorithms } from "./settings-manager";

export enum ValidationStatus {
  SUCCESS = "SUCCESS",
  FAILED = "FAILED", 
  WARNING = "WARNING"
}

export enum MatchConfidence {
  HIGH = "HIGH",     // 90%+ match
  MEDIUM = "MEDIUM", // 70-89% match
  LOW = "LOW",       // 50-69% match
  NO_MATCH = "NO_MATCH" // <50% match
}

export interface ValidationError {
  error_type: string;
  message: string;
  field_name?: string;
  suggested_fix?: string;
  line_number?: number;
  employee_name?: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  errors: ValidationError[];
  warnings: ValidationError[];
  validated_items: number;
  metadata: Record<string, any>;
}

export interface MatchResult {
  input_name: string;
  matched_name?: string;
  matched_id?: string;
  confidence: MatchConfidence;
  confidence_score: number;
  suggestions: Array<{
    name: string;
    employee_id?: string;
    score: number;
  }>;
  requires_confirmation: boolean;
}

export interface FuzzyMatchConfig {
  threshold: number;        // Minimum score for automatic matching
  cutoff: number;          // Minimum score to be considered a suggestion
  max_suggestions: number; // Maximum number of suggestions to return
}

export class ValidationResultBuilder {
  private result: ValidationResult;

  constructor() {
    this.result = {
      status: ValidationStatus.SUCCESS,
      errors: [],
      warnings: [],
      validated_items: 0,
      metadata: {}
    };
  }

  addError(
    error_type: string, 
    message: string, 
    field_name?: string, 
    suggested_fix?: string,
    line_number?: number,
    employee_name?: string
  ): this {
    this.result.errors.push({
      error_type,
      message,
      field_name,
      suggested_fix,
      line_number,
      employee_name
    });
    
    if (this.result.status === ValidationStatus.SUCCESS) {
      this.result.status = ValidationStatus.FAILED;
    }
    return this;
  }

  addWarning(
    error_type: string, 
    message: string, 
    field_name?: string, 
    suggested_fix?: string,
    line_number?: number,
    employee_name?: string
  ): this {
    this.result.warnings.push({
      error_type,
      message,
      field_name,
      suggested_fix,
      line_number,
      employee_name
    });
    
    if (this.result.status === ValidationStatus.SUCCESS) {
      this.result.status = ValidationStatus.WARNING;
    }
    return this;
  }

  setValidatedItems(count: number): this {
    this.result.validated_items = count;
    return this;
  }

  addMetadata(key: string, value: any): this {
    this.result.metadata[key] = value;
    return this;
  }

  build(): ValidationResult {
    return { ...this.result };
  }

  get isValid(): boolean {
    return this.result.status === ValidationStatus.SUCCESS && this.result.errors.length === 0;
  }

  get hasWarnings(): boolean {
    return this.result.warnings.length > 0;
  }

  getErrorSummary(): string {
    const lines: string[] = [];

    if (this.result.errors.length > 0) {
      lines.push("❌ Validation Errors:");
      for (const error of this.result.errors) {
        let errorLine = `  - ${error.message}`;
        if (error.field_name) errorLine += ` (${error.field_name})`;
        if (error.line_number) errorLine += ` [Line ${error.line_number}]`;
        if (error.employee_name) errorLine += ` [Employee: ${error.employee_name}]`;
        lines.push(errorLine);
        
        if (error.suggested_fix) {
          lines.push(`    💡 Suggestion: ${error.suggested_fix}`);
        }
      }
    }

    if (this.result.warnings.length > 0) {
      lines.push("⚠️ Validation Warnings:");
      for (const warning of this.result.warnings) {
        let warningLine = `  - ${warning.message}`;
        if (warning.field_name) warningLine += ` (${warning.field_name})`;
        if (warning.line_number) warningLine += ` [Line ${warning.line_number}]`;
        if (warning.employee_name) warningLine += ` [Employee: ${warning.employee_name}]`;
        lines.push(warningLine);
        
        if (warning.suggested_fix) {
          lines.push(`    💡 Suggestion: ${warning.suggested_fix}`);
        }
      }
    }

    if (lines.length === 0) {
      lines.push("✅ Validation passed successfully");
    }

    return lines.join('\n');
  }
}

export class EnhancedFuzzyMatcher {
  private config: FuzzyMatchConfig;

  constructor(config: Partial<FuzzyMatchConfig> = {}) {
    // Get dynamic thresholds from settings manager
    const thresholds = getValidationThresholds();
    
    this.config = {
      threshold: thresholds.high,        // Dynamic threshold for automatic matching
      cutoff: thresholds.low,           // Dynamic threshold for suggestions
      max_suggestions: 5,               // Keep configurable max suggestions
      ...config
    };
  }

  /**
   * Advanced fuzzy matching with multiple algorithms
   */
  findMatches(input: string, candidates: string[]): MatchResult {
    if (!input || !input.trim()) {
      return {
        input_name: input,
        confidence: MatchConfidence.NO_MATCH,
        confidence_score: 0,
        suggestions: [],
        requires_confirmation: true
      };
    }

    const normalizedInput = this.normalizeString(input);
    console.log(`🔍 Fuzzy matching: "${input}" (normalized: "${normalizedInput}") against ${candidates.length} candidates`);
    console.log(`⚙️ Current config - cutoff: ${this.config.cutoff}, threshold: ${this.config.threshold}`);
    
    const scores: Array<{ name: string; score: number }> = [];

    for (const candidate of candidates) {
      const normalizedCandidate = this.normalizeString(candidate);
      const score = this.calculateSimilarity(normalizedInput, normalizedCandidate);
      console.log(`🔍 Similarity "${input}" vs "${candidate}": ${score.toFixed(2)}% (cutoff: ${this.config.cutoff})`);
      
      if (score >= this.config.cutoff) {
        scores.push({ name: candidate, score });
      }
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);
    console.log(`🎯 Found ${scores.length} fuzzy matches for "${input}":`, scores.map(m => `${m.name} (${m.score.toFixed(2)}%)`));

    const result: MatchResult = {
      input_name: input,
      confidence: MatchConfidence.NO_MATCH,
      confidence_score: 0,
      suggestions: scores.slice(0, this.config.max_suggestions),
      requires_confirmation: true
    };

    if (scores.length > 0) {
      const bestMatch = scores[0];
      result.confidence_score = bestMatch.score;
      
      // Get dynamic thresholds
      const thresholds = getValidationThresholds();
      console.log(`📊 Thresholds - high: ${thresholds.high}, medium: ${thresholds.medium}, low: ${thresholds.low}`);
      
      if (bestMatch.score >= 95) {
        result.confidence = MatchConfidence.HIGH;
        result.matched_name = bestMatch.name;
        result.requires_confirmation = false;
        console.log(`✅ AUTO-MATCH: "${input}" → "${bestMatch.name}" (${bestMatch.score.toFixed(2)}%)`);
      } else if (bestMatch.score >= thresholds.high) {
        result.confidence = MatchConfidence.HIGH;
        result.matched_name = bestMatch.name;
        result.requires_confirmation = true;
        console.log(`🤔 HIGH CONFIDENCE NEEDS CONFIRMATION: "${input}" → "${bestMatch.name}" (${bestMatch.score.toFixed(2)}%)`);
      } else if (bestMatch.score >= thresholds.medium) {
        result.confidence = MatchConfidence.MEDIUM;
        result.matched_name = bestMatch.name;
        console.log(`⚠️ MEDIUM CONFIDENCE: "${input}" → "${bestMatch.name}" (${bestMatch.score.toFixed(2)}%)`);
      } else if (bestMatch.score >= thresholds.low) {
        result.confidence = MatchConfidence.LOW;
        console.log(`⚠️ LOW CONFIDENCE: "${input}" → "${bestMatch.name}" (${bestMatch.score.toFixed(2)}%)`);
      }
    } else {
      console.log(`❌ No fuzzy matches found for "${input}" above cutoff ${this.config.cutoff}%`);
    }

    return result;
  }

  /**
   * Calculate similarity using multiple algorithms based on enabled settings
   */
  private calculateSimilarity(str1: string, str2: string): number {
    // Exact match
    if (str1 === str2) return 100;

    // Get enabled algorithms from settings
    const enabledAlgorithms = getEnabledAlgorithms();
    
    let totalScore = 0;
    let totalWeight = 0;

    // Calculate scores for enabled algorithms only
    if (enabledAlgorithms.levenshtein) {
      const levScore = this.levenshteinSimilarity(str1, str2) * 100; // Convert to percentage
      totalScore += levScore * 0.4;
      totalWeight += 0.4;
    }
    
    if (enabledAlgorithms.jaccard) {
      const jaccardScore = this.jaccardSimilarity(str1, str2) * 100; // Convert to percentage
      totalScore += jaccardScore * 0.3;
      totalWeight += 0.3;
    }
    
    if (enabledAlgorithms.wordLevel) {
      const wordScore = this.wordSimilarity(str1, str2) * 100; // Convert to percentage
      totalScore += wordScore * 0.3;
      totalWeight += 0.3;
    }

    // Normalize by total weight to ensure consistent scoring
    const combined = totalWeight > 0 ? totalScore / totalWeight : 0;

    return Math.round(combined * 100) / 100;
  }

  /**
   * Levenshtein distance based similarity
   */
  private levenshteinSimilarity(str1: string, str2: string): number {
    const maxLength = Math.max(str1.length, str2.length);
    if (maxLength === 0) return 1;
    
    const distance = this.levenshteinDistance(str1, str2);
    return (maxLength - distance) / maxLength;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Jaccard similarity (set intersection over union)
   */
  private jaccardSimilarity(str1: string, str2: string): number {
    const set1 = new Set(str1.split(''));
    const set2 = new Set(str2.split(''));
    
    const set1Array = Array.from(set1);
    const set2Array = Array.from(set2);
    const intersection = new Set(set1Array.filter(x => set2.has(x)));
    const union = new Set([...set1Array, ...set2Array]);
    
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * Word-level similarity for names
   */
  private wordSimilarity(str1: string, str2: string): number {
    const words1 = str1.split(/\s+/).filter(w => w.length > 0);
    const words2 = str2.split(/\s+/).filter(w => w.length > 0);
    
    if (words1.length === 0 && words2.length === 0) return 1;
    if (words1.length === 0 || words2.length === 0) return 0;

    let matches = 0;
    const used = new Set<number>();

    for (const word1 of words1) {
      for (let i = 0; i < words2.length; i++) {
        if (used.has(i)) continue;
        
        const word2 = words2[i];
        if (word1 === word2 || 
            word1.includes(word2) || 
            word2.includes(word1) ||
            this.levenshteinSimilarity(word1, word2) > 0.8) {
          matches++;
          used.add(i);
          break;
        }
      }
    }

    return matches / Math.max(words1.length, words2.length);
  }

  /**
   * Normalize string for comparison
   */
  private normalizeString(str: string): string {
    return str
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, '')  // Remove punctuation
      .replace(/\s+/g, ' ');    // Normalize whitespace
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<FuzzyMatchConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export class RegionValidator {
  private xeroRegions: Set<string> = new Set();
  private regionCache: Map<string, boolean> = new Map();

  constructor(xeroRegions: string[] = []) {
    this.setXeroRegions(xeroRegions);
  }

  setXeroRegions(regions: string[]): void {
    this.xeroRegions = new Set(regions.map(r => r.trim()));
    this.regionCache.clear();
    console.log(`📍 Updated Xero regions: ${this.xeroRegions.size} regions available`);
  }

  validateRegion(regionName: string, lineNumber?: number): ValidationResult {
    const builder = new ValidationResultBuilder().setValidatedItems(1);

    if (!regionName || !regionName.trim()) {
      return builder.addError(
        "EMPTY_REGION",
        "Region name cannot be empty",
        "region_name",
        "Ensure all timesheet entries have valid region names",
        lineNumber
      ).build();
    }

    const normalizedRegion = regionName.trim();

    // Check cache first
    if (this.regionCache.has(normalizedRegion)) {
      const isValid = this.regionCache.get(normalizedRegion)!;
      if (!isValid) {
        return builder.addError(
          "INVALID_REGION",
          `Region '${normalizedRegion}' not found in Xero tracking categories`,
          "region_name",
          this.generateRegionSuggestion(normalizedRegion),
          lineNumber
        ).build();
      }
      return builder.build();
    }

    // Validate against Xero regions
    if (this.xeroRegions.size === 0) {
      return builder.addError(
        "NO_XERO_REGIONS",
        "No Xero regions available for validation",
        "xero_regions",
        "Ensure Xero API connection is established and regions are fetched"
      ).build();
    }

    const isValid = this.xeroRegions.has(normalizedRegion);
    this.regionCache.set(normalizedRegion, isValid);

    if (!isValid) {
      return builder.addError(
        "INVALID_REGION",
        `Region '${normalizedRegion}' not found in Xero tracking categories`,
        "region_name",
        this.generateRegionSuggestion(normalizedRegion),
        lineNumber
      ).build();
    }

    return builder.build();
  }

  validateRegions(regions: Set<string>): ValidationResult {
    const builder = new ValidationResultBuilder().setValidatedItems(regions.size);

    if (regions.size === 0) {
      return builder.addWarning(
        "NO_REGIONS",
        "No regions found to validate",
        "regions",
        "Ensure timesheet data contains region information"
      ).build();
    }

    const invalidRegions: string[] = [];
    let lineNumber = 1;

    for (const region of Array.from(regions).sort()) {
      const result = this.validateRegion(region, lineNumber++);
      
      // Merge errors and warnings
      result.errors.forEach(error => builder.addError(error.error_type, error.message, error.field_name, error.suggested_fix, error.line_number, error.employee_name));
      result.warnings.forEach(warning => builder.addWarning(warning.error_type, warning.message, warning.field_name, warning.suggested_fix, warning.line_number, warning.employee_name));

      if (!this.isRegionValid(result)) {
        invalidRegions.push(region);
      }
    }

    // Add metadata
    builder.addMetadata("total_regions", regions.size);
    builder.addMetadata("valid_regions", regions.size - invalidRegions.length);
    builder.addMetadata("invalid_regions", invalidRegions);
    builder.addMetadata("xero_regions_count", this.xeroRegions.size);

    return builder.build();
  }

  private isRegionValid(result: ValidationResult): boolean {
    return result.status === ValidationStatus.SUCCESS && result.errors.length === 0;
  }

  private generateRegionSuggestion(regionName: string): string {
    const similarRegions = this.findSimilarRegions(regionName);
    let suggestion = `Add '${regionName}' region in Xero under Payroll Settings > Timesheets > Categories`;
    
    if (similarRegions.length > 0) {
      suggestion += `. Did you mean: ${similarRegions.slice(0, 3).join(', ')}?`;
    }
    
    return suggestion;
  }

  private findSimilarRegions(regionName: string, threshold: number = 60): string[] {
    if (this.xeroRegions.size === 0) return [];

    const matcher = new EnhancedFuzzyMatcher({ cutoff: threshold });
    const result = matcher.findMatches(regionName, Array.from(this.xeroRegions));
    
    return result.suggestions.map(s => s.name);
  }

  getValidationSummary(regions: Set<string>): string {
    const result = this.validateRegions(regions);
    const builder = new ValidationResultBuilder();
    // Copy result data
    builder['result'] = result;
    return builder.getErrorSummary();
  }
}

export class EmployeeValidator {
  private knownEmployees: string[];
  private fuzzyMatcher: EnhancedFuzzyMatcher;

  constructor(knownEmployees: string[] = [], config: Partial<FuzzyMatchConfig> = {}) {
    this.knownEmployees = knownEmployees;
    this.fuzzyMatcher = new EnhancedFuzzyMatcher(config);
  }

  setKnownEmployees(employees: string[]): void {
    this.knownEmployees = employees;
    console.log(`👥 Updated known employees: ${employees.length} employees available`);
  }

  validateEmployee(employeeName: string, lineNumber?: number): MatchResult {
    if (!employeeName || !employeeName.trim()) {
      return {
        input_name: employeeName,
        confidence: MatchConfidence.NO_MATCH,
        confidence_score: 0,
        suggestions: [],
        requires_confirmation: true
      };
    }

    return this.fuzzyMatcher.findMatches(employeeName.trim(), this.knownEmployees);
  }

  validateEmployees(employees: string[]): ValidationResult {
    const builder = new ValidationResultBuilder().setValidatedItems(employees.length);

    if (employees.length === 0) {
      return builder.addWarning(
        "NO_EMPLOYEES",
        "No employees found to validate",
        "employees",
        "Ensure timesheet data contains employee information"
      ).build();
    }

    const unmatchedEmployees: string[] = [];
    const lowConfidenceMatches: string[] = [];
    let lineNumber = 1;

    for (const employee of employees) {
      const matchResult = this.validateEmployee(employee, lineNumber++);
      
      if (matchResult.confidence === MatchConfidence.NO_MATCH) {
        unmatchedEmployees.push(employee);
        builder.addError(
          "UNMATCHED_EMPLOYEE",
          `Employee '${employee}' not found in known employees`,
          "employee_name",
          this.generateEmployeeSuggestion(matchResult),
          lineNumber - 1,
          employee
        );
      } else if (matchResult.confidence === MatchConfidence.LOW) {
        lowConfidenceMatches.push(employee);
        builder.addWarning(
          "LOW_CONFIDENCE_MATCH", 
          `Low confidence match for '${employee}' → '${matchResult.matched_name}' (${Math.round(matchResult.confidence_score)}%)`,
          "employee_name",
          "Please verify this match is correct",
          lineNumber - 1,
          employee
        );
      } else if (matchResult.requires_confirmation) {
        builder.addWarning(
          "REQUIRES_CONFIRMATION",
          `Please confirm match for '${employee}' → '${matchResult.matched_name}' (${Math.round(matchResult.confidence_score)}%)`,
          "employee_name",
          "Confirm this automatic match is correct",
          lineNumber - 1,
          employee
        );
      }
    }

    // Add metadata
    builder.addMetadata("total_employees", employees.length);
    builder.addMetadata("unmatched_employees", unmatchedEmployees);
    builder.addMetadata("low_confidence_matches", lowConfidenceMatches);
    builder.addMetadata("known_employees_count", this.knownEmployees.length);

    return builder.build();
  }

  private generateEmployeeSuggestion(matchResult: MatchResult): string {
    if (matchResult.suggestions.length > 0) {
      const suggestions = matchResult.suggestions
        .slice(0, 3)
        .map(s => `${s.name} (${Math.round(s.score)}%)`)
        .join(', ');
      return `Did you mean: ${suggestions}?`;
    }
    return "Add this employee to the known employees list or check spelling";
  }

  updateConfig(config: Partial<FuzzyMatchConfig>): void {
    this.fuzzyMatcher.updateConfig(config);
  }
}

// Export singleton instances with default configuration
export const regionValidator = new RegionValidator();
export const employeeValidator = new EmployeeValidator();
export const fuzzyMatcher = new EnhancedFuzzyMatcher();