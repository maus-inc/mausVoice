import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style class merger (kept tiny; works without Tailwind when only used for conditional strings). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
