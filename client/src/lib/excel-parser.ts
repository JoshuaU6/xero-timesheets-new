// This file will be used for client-side Excel parsing utilities in the future
// Currently, all parsing is handled server-side for security and performance

export interface ExcelParseOptions {
  skipEmptyRows?: boolean;
  range?: string;
  header?: number | string[];
}

export interface ParsedSheet {
  name: string;
  data: any[][];
  headers?: string[];
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
  filename: string;
}

// Future client-side utilities for Excel validation and preview
export const validateExcelFile = (file: File): boolean => {
  const validTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
  ];
  
  return validTypes.includes(file.type) || file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
};

export const getFileSize = (file: File): string => {
  const bytes = file.size;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  
  if (bytes === 0) return '0 Bytes';
  
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
};
