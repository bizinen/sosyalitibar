import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";

export default async function TargetsPage() {
  if (!(await isAdmin())) redirect("/login");
  redirect("/");
}
