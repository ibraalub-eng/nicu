// Global type declarations for NICU application
// These are assigned at runtime by the IIFE modules

interface Window {
  // Config
  NICU_CONFIG: {
    SUPABASE_URL: string;
    SUPABASE_ANON_KEY: string;
    DB_ADAPTER: string;
    ORG_NAME: string;
  };

  // Shared constants & utilities
  NICU: {
    MONTHS: string[];
    MONTHS_AR: Record<string, string>;
    SERVICES: string[];
    SERVICE_AR: Record<string, string>;
    SERVICE_SHORT: Record<string, string>;
    COLUMNS: Array<{ label: string; field: string; db: string }>;
    FIELDS: string[];
    currentYM(): string;
    computeKpis(rows: any[]): { total: number; month: number; active: number; avgDays: number; daysSum: number; daysN: number };
    groupCount(rows: any[], keyFn: (r: any) => string): [string, number][];
  };

  // Database adapter factory
  DB_ADAPTERS: Record<string, () => any>;

  // Database facade
  db: {
    name: string;
    problems: string[];
    isReady(): boolean;
    isFileProtocol: boolean;
    storageKind: 'local' | 'memory';
    sessionWillSurviveReload: boolean;
    COLUMNS: any[];
    FIELDS: string[];
    auth: any;
    records: any;
    profiles: any;
    orgs: any;
    audit: any;
    sessions: any;
    revokeSession(payload: string | { refreshToken?: string | null; sessionId?: string | null } | null): Promise<void>;
  };

  // Authentication
  auth: {
    online: boolean;
    session: any;
    profile: any;
    init(): Promise<void>;
    login(email: string, password: string): Promise<void>;
    logout(): Promise<{ refreshToken?: string | null; sessionId?: string | null } | null>;
    onChange(handler: (session: any | null) => void): void;
    updatePassword(userId: string, password: string): Promise<void>;
    isAdmin(): boolean;
    isSuperAdmin(): boolean;
    isViewer(): boolean;
    servicesAllowed(): string[] | null;
    canViewService(svc: string): boolean;
    canWriteService(svc: string): boolean;
    staffEditAll: boolean;
    canEditRecords(): boolean;
    orgName(): string;
    orgId(): string | null;
    orgCode(): string;
    displayName(): string;
  };

  // Supabase client (loaded from vendor)
  supabase: {
    createClient(url: string, key: string, options?: any): any;
  };
}

// HTMLElement extensions
interface HTMLElement {
  __guarded?: boolean;
}

interface Document {
  getElementById(id: string): HTMLElement | null;
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): NodeListOf<Element>;
}

interface Element {
  closest(selector: string): Element | null;
}