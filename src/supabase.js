import { createClient } from "@supabase/supabase-js";

// Replace these with your Supabase project credentials
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "YOUR_SUPABASE_ANON_KEY";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── EMPLOYEES ────────────────────────────────────────────────────────────────
export async function fetchEmployees() {
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .order("name");
  if (error) throw error;
  return data.map((e) => ({
    id: e.id,
    name: e.name,
    empCode: e.emp_code,
    designation: e.designation || "",
    department: e.department || "",
    uanNo: e.uan_no || "",
    esicNo: e.esic_no || "",
    bankName: e.bank_name || "",
    accountNo: e.account_no || "",
    ifscCode: e.ifsc_code || "",
    dateOfJoining: e.date_of_joining || "",
    payScale: Number(e.pay_scale),
    esicApplicable: e.esic_applicable || false,
  }));
}

export async function saveEmployee(emp) {
  const { error } = await supabase.from("employees").upsert({
    id: emp.id,
    name: emp.name,
    emp_code: emp.empCode,
    designation: emp.designation,
    department: emp.department,
    uan_no: emp.uanNo,
    esic_no: emp.esicNo,
    bank_name: emp.bankName,
    account_no: emp.accountNo,
    ifsc_code: emp.ifscCode,
    date_of_joining: emp.dateOfJoining,
    pay_scale: emp.payScale,
    esic_applicable: emp.esicApplicable,
  });
  if (error) throw error;
}

export async function deleteEmployee(id) {
  const { error } = await supabase.from("employees").delete().eq("id", id);
  if (error) throw error;
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
export async function fetchSettings() {
  const { data, error } = await supabase
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  if (!data) return null;
  return {
    companyName: data.company_name || "Your Company Name",
    companyLogo: data.company_logo || "",
    pfCeiling: data.pf_ceiling ?? true,
    profTaxThreshold: Number(data.prof_tax_threshold) || 10000,
    profTaxAmount: Number(data.prof_tax_amount) || 200,
  };
}

export async function saveSettings(s) {
  const { error } = await supabase.from("settings").upsert({
    id: 1,
    company_name: s.companyName,
    company_logo: s.companyLogo,
    pf_ceiling: s.pfCeiling,
    prof_tax_threshold: s.profTaxThreshold,
    prof_tax_amount: s.profTaxAmount,
  });
  if (error) throw error;
}

// ─── PAYROLL ──────────────────────────────────────────────────────────────────
export async function fetchPayroll(year, month) {
  const { data, error } = await supabase
    .from("payroll")
    .select("*")
    .eq("year", year)
    .eq("month", month);
  if (error) throw error;
  const result = {};
  data.forEach((p) => {
    result[p.emp_id] = {
      daysAttended: Number(p.days_attended),
      leaveDays: Number(p.leave_days),
      incomeTax: Number(p.income_tax) || 0,
    };
  });
  return result;
}

export async function savePayrollEntry(empId, year, month, entry) {
  const { error } = await supabase.from("payroll").upsert(
    {
      emp_id: empId,
      year,
      month,
      days_attended: entry.daysAttended,
      leave_days: entry.leaveDays,
      income_tax: entry.incomeTax || 0,
    },
    { onConflict: "emp_id,year,month" }
  );
  if (error) throw error;
}
