"use client";

import { createContext, useContext } from "react";
import { type CurrentUser } from "@/lib/api";

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// This build ships with LOCAL_NO_AUTH=true and no auth router, so there is
// no /auth/* endpoint to talk to. We provide a static local operator and
// make all auth actions harmless no-ops rather than calling removed routes.
const LOCAL_USER: CurrentUser = {
  id: "00000000-0000-0000-0000-000000000011",
  email: "operator@localhost",
  full_name: "Local Operator",
  is_admin: true,
  is_superuser: true,
  tenant_id: "00000000-0000-0000-0000-000000000010",
  preferences: {},
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // No network call: auth is disabled in this build.
  const user = LOCAL_USER;
  const loading = false;

  async function refresh() {
    // No-op: there is no /auth/me endpoint in this build.
  }

  async function login() {
    // No-op: there is no /auth/login endpoint in this build.
  }

  async function logout() {
    // No-op: there is no /auth logout endpoint in this build.
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
