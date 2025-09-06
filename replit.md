# Overview

This is a timesheet processing application built with a React frontend and Express.js backend. The system allows users to upload multiple Excel files (site timesheet, travel timesheet, and overtime rates) and consolidates them into a structured JSON format. It performs fuzzy matching for employee names and regions, validates data against known employees and locations, and provides comprehensive processing summaries with detailed employee breakdowns.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React 18 with TypeScript using Vite as the build tool
- **UI Components**: Shadcn/ui component library with Radix UI primitives
- **Styling**: Tailwind CSS with CSS variables for theming support (light/dark mode)
- **State Management**: TanStack Query (React Query) for server state management
- **Routing**: Wouter for lightweight client-side routing
- **Form Handling**: React Hook Form with Zod validation resolvers

## Backend Architecture
- **Framework**: Express.js with TypeScript
- **File Processing**: Multer for multipart file uploads with memory storage
- **Excel Processing**: xlsx library for reading and parsing Excel files
- **Data Storage**: In-memory storage with MemStorage class (designed to be easily replaceable with database storage)
- **Validation**: Zod schemas for runtime type validation
- **API Design**: RESTful endpoints with structured JSON responses

## Data Processing Logic
- **Fuzzy Matching**: Custom algorithm for matching employee names and regions with configurable similarity thresholds
- **Known Data Validation**: Hardcoded reference lists for employees ("Charlotte Danes", "Chelsea Serati", "Jack Allan") and regions ("Eastside", "South", "North")
- **Consolidation Logic**: Merges data from multiple Excel sources into a unified timesheet structure with pay period calculations

## File Structure
- `/client` - React frontend application
- `/server` - Express.js backend with API routes
- `/shared` - Common TypeScript types and Zod schemas used by both frontend and backend
- `/components.json` - Shadcn/ui configuration
- Configuration files at root level for various tools (Tailwind, TypeScript, Vite, etc.)

## Development Setup
- **Build System**: Vite for frontend development with hot module replacement
- **TypeScript**: Strict mode enabled with path mapping for clean imports
- **Development Server**: Express server with Vite middleware integration in development mode
- **Production Build**: Frontend builds to static files, backend bundles with esbuild

# External Dependencies

## Database
- **Current**: In-memory storage using Map data structure
- **Planned**: PostgreSQL with Drizzle ORM (configuration present but not yet implemented)
- **Connection**: Neon Database serverless driver configured for PostgreSQL

## UI and Styling
- **Component Library**: Radix UI primitives for accessible, unstyled components
- **Icons**: Lucide React icon library
- **Styling**: Tailwind CSS with PostCSS processing
- **Fonts**: Google Fonts (Inter, JetBrains Mono, DM Sans, Geist Mono, Architects Daughter, Fira Code)

## File Processing
- **Excel Parsing**: SheetJS (xlsx) library for reading Excel files
- **File Upload**: Multer middleware for handling multipart/form-data uploads with 10MB file size limit

## Development Tools
- **Build Tool**: Vite with React plugin and runtime error overlay
- **Code Quality**: TypeScript strict mode, ESLint configuration implied
- **Development**: Replit-specific plugins for cartographer and development banner
- **Hot Reloading**: Vite HMR with Express middleware integration

## Runtime and Deployment
- **Node.js**: ES modules with top-level await support
- **Process Management**: Environment-based configuration with NODE_ENV detection
- **Static Serving**: Express static file serving for production builds
- **Error Handling**: Centralized error middleware with structured JSON responses