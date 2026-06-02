import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import jsPDF from "jspdf";
import { toJpeg } from "html-to-image";
import {
  fetchEmployees,
  saveEmployee as saveEmployeeDB,
  deleteEmployee as deleteEmployeeDB,
  fetchSettings,
  saveSettings as saveSettingsDB,
  fetchPayroll,
  savePayrollEntry,
} from "./supabase";

// ─── STORAGE KEYS ────────────────────────────────────────────────────────────
const DB = {
  employees: "payroll_employees",
  settings: "payroll_settings",
  payroll: (y, m) => `payroll_${y}_${String(m).padStart(2, "0")}`,
};

// ─── UTILITIES ───────────────────────────────────────────────────────────────
const formatINR = (n) =>
  n == null || isNaN(n) ? "₹0" : "₹" + Math.round(n).toLocaleString("en-IN");

const getDaysInMonth = (m, y) => new Date(y, m + 1, 0).getDate();

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const genId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2);

// ─── SALARY CALCULATION ENGINE ───────────────────────────────────────────────
function calcComponents(payScale) {
  const basic = Math.round(payScale * 0.5);
  const hra = Math.round(basic * 0.4);
  const conveyance = 1600;
  const medical = 2500;
  const bonus = Math.round(basic * 0.0833);
  const special = payScale - (basic + hra + conveyance + medical + bonus);
  const pfBase = basic + conveyance + special; // PF calculated on this
  const grossPayPF = basic + hra + conveyance + medical + special;
  return {
    basic,
    hra,
    conveyance,
    medical,
    bonus,
    special,
    pfBase,
    grossPayPF,
    grossPay: payScale,
  };
}

function calcEarned(components, daysAttended, totalDays) {
  const ratio =
    totalDays > 0 ? Math.max(0, Math.min(1, daysAttended / totalDays)) : 0;
  const earnedBasic = Math.round(components.basic * ratio);
  const earnedHRA = Math.round(components.hra * ratio);
  const earnedConveyance = Math.round(components.conveyance * ratio);
  const earnedMedical = Math.round(components.medical * ratio);
  const earnedSpecial = Math.round(components.special * ratio);
  const earnedBonus = Math.round(components.bonus * ratio);
  const earnedPFBase = earnedBasic + earnedConveyance + earnedSpecial; // PF applies on Basic + Conveyance + Special
  const earnedGrossPayPF =
    earnedBasic + earnedHRA + earnedConveyance + earnedMedical + earnedSpecial;
  const earnedGrossPay = earnedGrossPayPF + earnedBonus;
  return {
    earnedBasic,
    earnedHRA,
    earnedConveyance,
    earnedMedical,
    earnedSpecial,
    earnedBonus,
    earnedPFBase,
    earnedGrossPayPF,
    earnedGrossPay,
  };
}

function calcDeductions(earned, emp, settings) {
  // PF Base = Basic + Conveyance + Special (capped at 15000 if ceiling on)
  const pfBase =
    settings.pfCeiling && earned.earnedPFBase > 15000
      ? 15000
      : earned.earnedPFBase;
  const pfEmployee = Math.round(pfBase * 0.12);
  const esicEmployee =
    emp.esicApplicable && earned.earnedGrossPay <= 21000
      ? Math.round(earned.earnedGrossPay * 0.0075)
      : null;
  const profTax =
    earned.earnedGrossPay > (settings.profTaxThreshold || 10000)
      ? settings.profTaxAmount || 200
      : 0;
  return { pfEmployee, esicEmployee, profTax };
}

function calcManagement(earned, emp, settings) {
  // Employer PF uses same base as employee PF (capped at 15000 if pfCeiling on)
  const pfBase =
    settings.pfCeiling && earned.earnedPFBase > 15000
      ? 15000
      : earned.earnedPFBase;
  const pfManagement = Math.round(pfBase * 0.12);
  const esicManagement =
    emp.esicApplicable && earned.earnedGrossPay <= 21000
      ? Math.round(earned.earnedGrossPay * 0.0325)
      : null;
  return { pfManagement, esicManagement };
}

function getFullCalc(emp, daysAttended, totalDays, incomeTax, settings) {
  const components = calcComponents(emp.payScale);
  const earned = calcEarned(components, daysAttended, totalDays);
  const deductions = calcDeductions(earned, emp, settings);
  const mgmt = calcManagement(earned, emp, settings);
  const totalDeductions =
    deductions.pfEmployee +
    (deductions.esicEmployee || 0) +
    deductions.profTax +
    (incomeTax || 0) +
    mgmt.pfManagement +
    (mgmt.esicManagement || 0);
  const netPay = earned.earnedGrossPay - totalDeductions;
  // CTC = PayScale (employer PF/ESIC already baked into payscale components)
  const ctc = earned.earnedGrossPay;
  return { components, earned, deductions, mgmt, totalDeductions, netPay, ctc };
}

// ─── DEFAULT DATA ────────────────────────────────────────────────────────────
const defaultSettings = {
  companyName: "Your Company Name",
  companyLogo: "",
  pfCeiling: true,
  profTaxThreshold: 10000,
  profTaxAmount: 200,
};

const emptyEmployee = {
  id: "",
  name: "",
  empCode: "",
  designation: "",
  department: "",
  uanNo: "",
  esicNo: "",
  bankName: "",
  accountNo: "",
  ifscCode: "",
  dateOfJoining: "",
  payScale: 0,
  esicApplicable: false,
};

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function PayrollApp() {
  const [tab, setTab] = useState("employees");
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [toast, setToast] = useState(null);

  // Load data from Supabase on mount
  useEffect(() => {
    async function loadData() {
      try {
        const [emps, sett] = await Promise.all([
          fetchEmployees(),
          fetchSettings(),
        ]);
        setEmployees(emps || []);
        if (sett) setSettings({ ...defaultSettings, ...sett });
      } catch (err) {
        console.error("Supabase load error:", err);
        // Fallback to localStorage
        try {
          setEmployees(JSON.parse(localStorage.getItem(DB.employees)) || []);
          setSettings({
            ...defaultSettings,
            ...JSON.parse(localStorage.getItem(DB.settings)),
          });
        } catch {
          /* ignore */
        }
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Sync to localStorage as backup
  useEffect(() => {
    if (!loading) localStorage.setItem(DB.employees, JSON.stringify(employees));
  }, [employees, loading]);
  useEffect(() => {
    if (!loading) localStorage.setItem(DB.settings, JSON.stringify(settings));
  }, [settings, loading]);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const notify = (msg, type = "success") => setToast({ msg, type });

  // Wrapped setters that sync to Supabase
  const updateEmployees = useCallback((newEmps) => {
    setEmployees(newEmps);
  }, []);

  const updateSettings = useCallback(async (newSettings) => {
    setSettings(newSettings);
    try {
      await saveSettingsDB(newSettings);
    } catch (err) {
      console.error("Settings save error:", err);
    }
  }, []);

  const tabs = [
    { id: "employees", label: "Employees", icon: "👥" },
    { id: "slips", label: "Payroll & Slips", icon: "📄" },
    { id: "settings", label: "Settings", icon: "⚙️" },
  ];

  return (
    <div className="min-h-screen bg-[#f5f7fa] flex">
      {/* Sidebar */}
      <aside className="w-60 bg-[#1B2A4A] text-white flex flex-col fixed h-full z-10">
        <div className="px-5 py-6 border-b border-white/10">
          <h1 className="text-lg font-bold tracking-tight">Zoho Payroll</h1>
          <p className="text-xs text-blue-200 mt-0.5">HR Management System</p>
        </div>
        <nav className="flex-1 py-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full text-left px-5 py-3 flex items-center gap-3 text-sm transition-all ${
                tab === t.id
                  ? "bg-white/10 text-white font-medium border-r-3 border-blue-400"
                  : "text-blue-100/70 hover:bg-white/5 hover:text-white"
              }`}
            >
              <span className="text-base">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-white/10 text-xs text-blue-200/50">
          v1.0 • ☁️ Cloud synced
        </div>
      </aside>

      {/* Main Content */}
      <main className="ml-60 flex-1 p-8 min-h-screen">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
              <p className="text-gray-500">Loading data...</p>
            </div>
          </div>
        ) : (
          <>
            {tab === "employees" && (
              <EmployeeSection
                employees={employees}
                setEmployees={updateEmployees}
                notify={notify}
              />
            )}
            {tab === "slips" && (
              <SlipSection
                employees={employees}
                settings={settings}
                notify={notify}
              />
            )}
            {tab === "settings" && (
              <SettingsSection
                settings={settings}
                setSettings={updateSettings}
                notify={notify}
              />
            )}
          </>
        )}
      </main>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 px-5 py-3 rounded-lg shadow-xl text-white text-sm font-medium z-50 ${
            toast.type === "success" ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── EMPLOYEE SECTION ────────────────────────────────────────────────────────
function EmployeeSection({ employees, setEmployees, notify }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyEmployee);
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");

  const openAdd = () => {
    setForm(emptyEmployee);
    setEditing(null);
    setShowForm(true);
  };
  const openEdit = (emp) => {
    setForm(emp);
    setEditing(emp.id);
    setShowForm(true);
  };

  const saveEmployee = async (e) => {
    e.preventDefault();
    const empData = editing
      ? { ...form, id: editing }
      : { ...form, id: genId() };
    try {
      await saveEmployeeDB(empData);
      if (editing) {
        setEmployees(
          employees.map((emp) => (emp.id === editing ? empData : emp)),
        );
        notify("Employee updated");
      } else {
        setEmployees([...employees, empData]);
        notify("Employee added");
      }
      setShowForm(false);
    } catch (err) {
      console.error("Save error:", err);
      notify("Save failed - check connection", "error");
    }
  };

  const deleteEmployee = async (id) => {
    if (confirm("Delete this employee permanently?")) {
      try {
        await deleteEmployeeDB(id);
        setEmployees(employees.filter((e) => e.id !== id));
        notify("Employee deleted");
      } catch (err) {
        console.error("Delete error:", err);
        notify("Delete failed", "error");
      }
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return employees;
    const q = search.toLowerCase();
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (e.empCode || "").toLowerCase().includes(q) ||
        (e.department || "").toLowerCase().includes(q) ||
        (e.designation || "").toLowerCase().includes(q),
    );
  }, [employees, search]);

  const handleBulkImport = () => {
    const lines = importText
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim());
    if (lines.length < 2) {
      notify("Need at least a header row and one data row", "error");
      return;
    }
    const header = lines[0]
      .toLowerCase()
      .split(",")
      .map((h) => h.trim().replace(/"/g, ""));
    const cols = {
      name: header.indexOf("name"),
      empCode: header.indexOf("empcode"),
      designation: header.indexOf("designation"),
      department: header.indexOf("department"),
      uanNo: header.indexOf("uanno"),
      esicNo: header.indexOf("esicno"),
      bankName: header.indexOf("bankname"),
      accountNo: header.indexOf("accountno"),
      ifscCode: header.indexOf("ifsc"),
      dateOfJoining: header.indexOf("dateofjoining"),
      payScale: header.indexOf("payscale"),
      esicApplicable: header.indexOf("esicapplicable"),
    };
    if (cols.name < 0 || cols.empCode < 0 || cols.payScale < 0) {
      notify("CSV must contain: name, empCode, payScale columns", "error");
      return;
    }
    const newEmps = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i]
        .split(",")
        .map((c) => c.trim().replace(/^"|"$/g, ""));
      const get = (idx) => (idx >= 0 ? row[idx] || "" : "");
      const getNum = (idx) => (idx >= 0 ? parseFloat(row[idx]) || 0 : 0);
      newEmps.push({
        id: genId(),
        name: get(cols.name),
        empCode: get(cols.empCode),
        designation: get(cols.designation),
        department: get(cols.department),
        uanNo: get(cols.uanNo),
        esicNo: get(cols.esicNo),
        bankName: get(cols.bankName),
        accountNo: get(cols.accountNo),
        ifscCode: get(cols.ifscCode),
        dateOfJoining: get(cols.dateOfJoining),
        payScale: getNum(cols.payScale),
        esicApplicable:
          get(cols.esicApplicable).toLowerCase() === "yes" ||
          get(cols.esicApplicable) === "true" ||
          get(cols.esicApplicable) === "1",
      });
    }
    // Save all to Supabase
    Promise.all(newEmps.map((emp) => saveEmployeeDB(emp)))
      .then(() => {
        setEmployees([...employees, ...newEmps]);
        setShowImport(false);
        setImportText("");
        notify(`${newEmps.length} employees imported`);
      })
      .catch((err) => {
        console.error("Bulk import error:", err);
        notify("Import failed - check connection", "error");
      });
  };

  const renderField = (label, name, type = "text", required = false) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}
      </label>
      <input
        type={type}
        required={required}
        value={form[name] || ""}
        onChange={(e) =>
          setForm({
            ...form,
            [name]:
              type === "number"
                ? parseFloat(e.target.value) || 0
                : e.target.value,
          })
        }
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
      />
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">
              Employee Master
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {employees.length} employee{employees.length !== 1 ? "s" : ""}{" "}
              registered
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowImport(true)}
              className="bg-gray-100 text-gray-700 px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-gray-200 transition border border-gray-300"
            >
              📥 Bulk Import
            </button>
            <button
              onClick={openAdd}
              className="bg-blue-600 text-white px-5 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition shadow-sm"
            >
              + Add Employee
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="flex gap-3">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search by name, code, department, or designation..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <span className="absolute left-3 top-2.5 text-gray-400 text-sm">
              🔍
            </span>
          </div>
          {search && (
            <span className="text-sm text-gray-500 py-2.5">
              {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Employee Table */}
      {employees.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-16 text-center">
          <p className="text-gray-400 text-lg">No employees added yet</p>
          <p className="text-gray-400 text-sm mt-1">
            Click "Add Employee" or use "Bulk Import"
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-400">No employees match "{search}"</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b sticky top-0 z-10">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">
                    Employee
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">
                    Code
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">
                    Department
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">
                    Designation
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">
                    Pay Scale
                  </th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600">
                    ESIC
                  </th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((emp, i) => (
                  <tr
                    key={emp.id}
                    className={`border-b last:border-0 hover:bg-blue-50/50 transition ${i % 2 === 0 ? "" : "bg-gray-50/50"}`}
                  >
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {emp.name}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{emp.empCode}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {emp.department}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {emp.designation}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-800">
                      {formatINR(emp.payScale)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {emp.esicApplicable ? (
                        <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs font-medium">
                          Yes
                        </span>
                      ) : (
                        <span className="bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full text-xs font-medium">
                          No
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => openEdit(emp)}
                        className="text-blue-600 hover:text-blue-800 font-medium text-xs mr-3"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteEmployee(emp.id)}
                        className="text-red-500 hover:text-red-700 font-medium text-xs"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Employee Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b flex justify-between items-center sticky top-0 bg-white rounded-t-2xl">
              <h3 className="text-lg font-bold text-gray-800">
                {editing ? "Edit Employee" : "Add New Employee"}
              </h3>
              <button
                onClick={() => setShowForm(false)}
                className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
              >
                &times;
              </button>
            </div>
            <form onSubmit={saveEmployee} className="p-6">
              <div className="grid grid-cols-2 gap-4">
                {renderField("Full Name", "name", "text", true)}
                {renderField("Employee Code", "empCode", "text", true)}
                {renderField("Designation", "designation")}
                {renderField("Department", "department")}
                {renderField("UAN No.", "uanNo")}
                {renderField("ESIC No.", "esicNo")}
                {renderField("Bank Name", "bankName")}
                {renderField("Account No.", "accountNo")}
                {renderField("IFSC Code", "ifscCode")}
                {renderField("Date of Joining", "dateOfJoining", "date")}
                {renderField("Pay Scale (₹/month)", "payScale", "number", true)}
                <div className="flex items-center gap-3 pt-5">
                  <input
                    type="checkbox"
                    checked={form.esicApplicable}
                    onChange={(e) =>
                      setForm({ ...form, esicApplicable: e.target.checked })
                    }
                    className="w-4 h-4 rounded text-blue-600"
                    id="esic-toggle"
                  />
                  <label
                    htmlFor="esic-toggle"
                    className="text-sm text-gray-700 font-medium"
                  >
                    ESIC Applicable
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 shadow-sm"
                >
                  {editing ? "Update Employee" : "Add Employee"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk Import Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b flex justify-between items-center">
              <h3 className="text-lg font-bold text-gray-800">
                Bulk Import Employees
              </h3>
              <button
                onClick={() => {
                  setShowImport(false);
                  setImportText("");
                }}
                className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
              >
                &times;
              </button>
            </div>
            <div className="p-6 flex-1 overflow-y-auto">
              <p className="text-sm text-gray-500 mb-2">
                Paste CSV data. Required columns: <b>name, empCode, payScale</b>
              </p>
              <p className="text-xs text-gray-400 mb-3">
                Optional: designation, department, uanNo, esicNo, bankName,
                accountNo, ifscCode, dateOfJoining, esicApplicable (yes/no)
              </p>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={`name,empCode,designation,department,payScale,esicApplicable\nJohn Doe,EMP001,Developer,IT,50000,no\nJane Smith,EMP002,Manager,HR,75000,yes`}
                className="w-full h-64 border border-gray-300 rounded-lg p-3 text-xs font-mono focus:ring-2 focus:ring-blue-500 outline-none resize-none"
              />
            </div>
            <div className="px-6 py-4 border-t flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowImport(false);
                  setImportText("");
                }}
                className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkImport}
                className="px-5 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 shadow-sm"
              >
                Import{" "}
                {importText.trim()
                  ? importText.trim().split(/\n/).length - 1
                  : 0}{" "}
                Employees
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── COMBINED PAYROLL & SALARY SLIP SECTION ──────────────────────────────────
function SlipSection({ employees, settings, notify }) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth());
  const [year, setYear] = useState(now.getFullYear());
  const [search, setSearch] = useState("");
  const [selectedEmpId, setSelectedEmpId] = useState("");
  const [payroll, setPayroll] = useState({});
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const pdfRef = useRef(null);
  const totalDays = getDaysInMonth(month, year);
  const storageKey = DB.payroll(year, month);
  const years = Array.from({ length: 10 }, (_, i) => 2022 + i);

  // Load payroll from Supabase
  useEffect(() => {
    async function loadPayroll() {
      try {
        const data = await fetchPayroll(year, month);
        setPayroll(data || {});
      } catch (err) {
        console.error("Payroll load error:", err);
        try {
          setPayroll(JSON.parse(localStorage.getItem(storageKey)) || {});
        } catch {
          setPayroll({});
        }
      }
    }
    loadPayroll();
  }, [month, year, storageKey]);

  // Backup to localStorage
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(payroll));
  }, [payroll, storageKey]);

  const getEntry = (empId) =>
    payroll[empId] || { daysAttended: totalDays, leaveDays: 0, incomeTax: 0 };

  const updateField = (empId, field, value) => {
    const newEntry = { ...getEntry(empId), [field]: parseFloat(value) || 0 };
    setPayroll((prev) => ({ ...prev, [empId]: newEntry }));
    savePayrollEntry(empId, year, month, newEntry).catch(console.error);
  };

  const updateLeave = (empId, leaves) => {
    const newEntry = {
      ...getEntry(empId),
      leaveDays: leaves,
      daysAttended: Math.max(0, totalDays - leaves),
    };
    setPayroll((prev) => ({ ...prev, [empId]: newEntry }));
    savePayrollEntry(empId, year, month, newEntry).catch(console.error);
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return employees;
    const q = search.toLowerCase();
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (e.empCode || "").toLowerCase().includes(q) ||
        (e.department || "").toLowerCase().includes(q),
    );
  }, [employees, search]);

  const selectedEmployee = employees.find((e) => e.id === selectedEmpId);
  const selectedEntry = getEntry(selectedEmpId);
  const selectedCalc = selectedEmployee
    ? getFullCalc(
        selectedEmployee,
        selectedEntry.daysAttended,
        totalDays,
        selectedEntry.incomeTax,
        settings,
      )
    : null;

  // Single PDF download
  const handleDownloadPDF = async (emp, entry) => {
    const calc = getFullCalc(
      emp,
      entry.daysAttended,
      totalDays,
      entry.incomeTax,
      settings,
    );

    // Create temporary container for rendering
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = "-9999px";
    container.style.width = "794px";
    container.style.background = "white";
    document.body.appendChild(container);

    // Render slip content
    const root = await import("react-dom/client");
    const slipRoot = root.createRoot(container);
    await new Promise((resolve) => {
      slipRoot.render(
        <SalarySlipContent
          employee={emp}
          calc={calc}
          entry={entry}
          month={month}
          year={year}
          totalDays={totalDays}
          settings={settings}
        />,
      );
      setTimeout(resolve, 100);
    });

    const dataUrl = await toJpeg(container, {
      pixelRatio: 2,
      quality: 0.92,
      backgroundColor: "#ffffff",
    });
    slipRoot.unmount();
    document.body.removeChild(container);

    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    const img = new Image();
    img.src = dataUrl;
    await new Promise((res) => {
      img.onload = res;
    });

    const imgWidth = pageWidth;
    const imgHeight = (img.height * imgWidth) / img.width;
    const scale = imgHeight > pageHeight ? pageHeight / imgHeight : 1;
    const finalWidth = imgWidth * scale;
    const finalHeight = imgHeight * scale;
    const x = (pageWidth - finalWidth) / 2;

    pdf.addImage(
      dataUrl,
      "JPEG",
      x,
      0,
      finalWidth,
      finalHeight,
      undefined,
      "FAST",
    );
    pdf.save(`Salary_Slip_${emp.name}_${MONTHS[month]}_${year}.pdf`);
  };

  // Bulk PDF download
  const handleBulkDownload = async () => {
    if (filtered.length === 0) return;
    setBulkDownloading(true);
    notify(`Generating ${filtered.length} PDFs...`);

    try {
      for (let i = 0; i < filtered.length; i++) {
        const emp = filtered[i];
        const entry = getEntry(emp.id);
        await handleDownloadPDF(emp, entry);
        // Small delay between downloads
        await new Promise((r) => setTimeout(r, 300));
      }
      notify(`Downloaded ${filtered.length} salary slips`);
    } catch (err) {
      console.error("Bulk download error:", err);
      notify("Some downloads failed", "error");
    } finally {
      setBulkDownloading(false);
    }
  };

  // Preview selected slip download
  const handlePreviewDownload = async () => {
    if (!pdfRef.current || !selectedEmployee) return;
    const dataUrl = await toJpeg(pdfRef.current, {
      pixelRatio: 2,
      quality: 0.92,
      backgroundColor: "#ffffff",
    });
    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const img = new Image();
    img.src = dataUrl;
    await new Promise((res) => {
      img.onload = res;
    });
    const imgWidth = pageWidth;
    const imgHeight = (img.height * imgWidth) / img.width;
    const scale = imgHeight > pageHeight ? pageHeight / imgHeight : 1;
    pdf.addImage(
      dataUrl,
      "JPEG",
      (pageWidth - imgWidth * scale) / 2,
      0,
      imgWidth * scale,
      imgHeight * scale,
      undefined,
      "FAST",
    );
    pdf.save(
      `Salary_Slip_${selectedEmployee.name}_${MONTHS[month]}_${year}.pdf`,
    );
  };

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-6 flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">
            Payroll & Salary Slips
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Manage attendance, leave & download salary slips
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={month}
            onChange={(e) => setMonth(parseInt(e.target.value))}
            className="border border-gray-300 px-3 py-2 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          >
            {MONTHS.map((m, i) => (
              <option key={i} value={i}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value))}
            className="border border-gray-300 px-3 py-2 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            onClick={handleBulkDownload}
            disabled={bulkDownloading || filtered.length === 0}
            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {bulkDownloading
              ? "⏳ Downloading..."
              : `⬇ Bulk Download (${filtered.length})`}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left: Employee Table */}
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="p-4 border-b bg-gray-50">
            <div className="flex items-center gap-3">
              <input
                type="text"
                placeholder="Search employees..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 border border-gray-300 px-3 py-2 pl-9 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
              <span className="text-sm text-gray-500">{totalDays} days</span>
            </div>
          </div>
          <div className="overflow-auto max-h-[600px]">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 sticky top-0">
                <tr>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700">
                    Employee
                  </th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-700 w-20">
                    Leave
                  </th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-700 w-20">
                    Present
                  </th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-700 w-24">
                    Income Tax
                  </th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-700 w-20">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((emp) => {
                  const entry = getEntry(emp.id);
                  const calc = getFullCalc(
                    emp,
                    entry.daysAttended,
                    totalDays,
                    entry.incomeTax,
                    settings,
                  );
                  return (
                    <tr
                      key={emp.id}
                      className={`border-b hover:bg-blue-50 cursor-pointer transition ${selectedEmpId === emp.id ? "bg-blue-100" : ""}`}
                      onClick={() => setSelectedEmpId(emp.id)}
                    >
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-gray-800">
                          {emp.name}
                        </div>
                        <div className="text-xs text-gray-500">
                          {emp.empCode} • {emp.department || "—"}
                        </div>
                      </td>
                      <td
                        className="px-3 py-2.5 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="number"
                          min="0"
                          max={totalDays}
                          value={entry.leaveDays}
                          onChange={(e) =>
                            updateLeave(emp.id, parseFloat(e.target.value) || 0)
                          }
                          className="w-14 text-center border border-gray-300 rounded px-1 py-1 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </td>
                      <td className="px-3 py-2.5 text-center font-medium text-gray-700">
                        {entry.daysAttended}
                      </td>
                      <td
                        className="px-3 py-2.5 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="number"
                          min="0"
                          value={entry.incomeTax}
                          onChange={(e) =>
                            updateField(emp.id, "incomeTax", e.target.value)
                          }
                          className="w-20 text-center border border-gray-300 rounded px-1 py-1 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </td>
                      <td
                        className="px-3 py-2.5 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => handleDownloadPDF(emp, entry)}
                          className="text-blue-600 hover:text-blue-800 text-lg"
                          title="Download PDF"
                        >
                          ⬇
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="p-8 text-center text-gray-400">
                No employees found
              </div>
            )}
          </div>
        </div>

        {/* Right: Salary Slip Preview */}
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="p-4 border-b bg-gray-50 flex justify-between items-center">
            <span className="font-semibold text-gray-700">
              {selectedEmployee
                ? `${selectedEmployee.name}'s Slip`
                : "Salary Slip Preview"}
            </span>
            {selectedEmployee && selectedCalc && (
              <button
                onClick={handlePreviewDownload}
                className="bg-[#1B2A4A] text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-[#243a63] transition"
              >
                ⬇ Download
              </button>
            )}
          </div>
          <div className="overflow-auto max-h-[600px] p-4">
            {!selectedEmployee || !selectedCalc ? (
              <div className="p-16 text-center text-gray-400">
                Click on an employee to preview their salary slip
              </div>
            ) : (
              <div
                ref={pdfRef}
                className="bg-white border rounded-lg overflow-hidden"
                style={{ width: "100%" }}
              >
                <SalarySlipContent
                  employee={selectedEmployee}
                  calc={selectedCalc}
                  entry={selectedEntry}
                  month={month}
                  year={year}
                  totalDays={totalDays}
                  settings={settings}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SALARY SLIP CONTENT (shared between preview and print) ──────────────────
const SalarySlipContent = ({
  employee,
  calc,
  entry,
  month,
  year,
  totalDays,
  settings,
}) => {
  const { earned, deductions, totalDeductions, netPay } = calc;
  const emp = employee;
  const BLUE = "#1e3a5f";
  const cellBorder = "1px solid #cbd5e1";

  return (
    <div
      style={{
        fontFamily: "'Segoe UI', Arial, sans-serif",
        width: "794px",
        minHeight: "1123px",
        backgroundColor: "white",
        display: "flex",
        flexDirection: "column",
        borderLeft: `4px solid ${BLUE}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "24px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {settings.companyLogo ? (
            <img
              src={settings.companyLogo}
              alt="Logo"
              style={{ height: "45px", objectFit: "contain" }}
            />
          ) : (
            <div style={{ fontSize: "28px", fontWeight: "700", color: BLUE }}>
              <span style={{ fontWeight: "300" }}>E</span>A |{" "}
              <span style={{ fontWeight: "400" }}>EUROASIA</span>
            </div>
          )}
        </div>
        <div
          style={{
            backgroundColor: BLUE,
            color: "white",
            padding: "10px 28px",
            borderRadius: "20px",
            fontSize: "12px",
            fontWeight: "500",
          }}
        >
          {settings.companyAddress || "Company Address"}
        </div>
      </div>

      {/* Title */}
      <div style={{ textAlign: "center", padding: "8px 0 20px" }}>
        <span
          style={{
            fontSize: "13px",
            fontWeight: "600",
            color: BLUE,
            borderBottom: `2px solid ${BLUE}`,
            paddingBottom: "6px",
            letterSpacing: "0.5px",
          }}
        >
          SALARY SLIP – {MONTHS[month]?.toUpperCase()} {year}
        </span>
      </div>

      {/* Employee Details */}
      <div style={{ padding: "0 32px", marginBottom: "20px" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "11px",
          }}
        >
          <tbody>
            {[
              [
                "Employee Name",
                emp.name?.toUpperCase() || "—",
                "Employee Code",
                emp.empCode || "—",
              ],
              [
                "Designation",
                emp.designation?.toUpperCase() || "—",
                "UAN No.",
                emp.uanNo || "—",
              ],
              ["ESIC No.", emp.esicNo || "NA", "Total Days", totalDays],
              [
                "Date of Joining",
                emp.dateOfJoining || "—",
                "Attendance",
                entry.daysAttended,
              ],
            ].map(([l1, v1, l2, v2], i) => (
              <tr key={i}>
                <td
                  style={{
                    padding: "10px 14px",
                    borderLeft: `3px solid ${BLUE}`,
                    borderTop: cellBorder,
                    borderBottom: cellBorder,
                    backgroundColor: "#f8fafc",
                    color: "#64748b",
                    fontWeight: "500",
                    width: "15%",
                  }}
                >
                  {l1}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderTop: cellBorder,
                    borderBottom: cellBorder,
                    fontWeight: "600",
                    color: "#1e293b",
                    width: "35%",
                  }}
                >
                  {v1}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderLeft: `3px solid ${BLUE}`,
                    borderTop: cellBorder,
                    borderBottom: cellBorder,
                    backgroundColor: "#f8fafc",
                    color: "#64748b",
                    fontWeight: "500",
                    width: "15%",
                  }}
                >
                  {l2}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderTop: cellBorder,
                    borderBottom: cellBorder,
                    fontWeight: "600",
                    color: "#1e293b",
                    width: "35%",
                  }}
                >
                  {v2}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Earnings & Deductions Tables */}
      <div
        style={{
          padding: "0 32px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0",
          flexGrow: 1,
        }}
      >
        {/* Earnings */}
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "11px",
            height: "fit-content",
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  backgroundColor: BLUE,
                  color: "white",
                  padding: "10px 12px",
                  textAlign: "left",
                  fontWeight: "600",
                  border: `1px solid ${BLUE}`,
                }}
              >
                EARNINGS
              </th>
              <th
                style={{
                  backgroundColor: BLUE,
                  color: "white",
                  padding: "10px 12px",
                  textAlign: "right",
                  fontWeight: "600",
                  border: `1px solid ${BLUE}`,
                }}
              >
                AMOUNT (₹)
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              ["Basic Salary (50%)", earned.earnedBasic],
              ["HRA (40%)", earned.earnedHRA],
              ["Conveyance Allowance", earned.earnedConveyance],
              ["Medical Allowance", earned.earnedMedical],
              ["Special Allowance", earned.earnedSpecial],
              ["Bonus (8.33%)", earned.earnedBonus],
            ].map(([label, amount], i) => (
              <tr key={i}>
                <td
                  style={{
                    padding: "9px 12px",
                    border: cellBorder,
                    color: "#475569",
                  }}
                >
                  {label}
                </td>
                <td
                  style={{
                    padding: "9px 12px",
                    border: cellBorder,
                    textAlign: "right",
                    color: "#1e293b",
                  }}
                >
                  {Math.round(amount || 0).toLocaleString("en-IN")}
                </td>
              </tr>
            ))}
            <tr style={{ backgroundColor: "#f1f5f9" }}>
              <td
                style={{
                  padding: "10px 12px",
                  border: cellBorder,
                  fontWeight: "600",
                  color: "#1e293b",
                }}
              >
                GROSS PAY
              </td>
              <td
                style={{
                  padding: "10px 12px",
                  border: cellBorder,
                  textAlign: "right",
                  fontWeight: "600",
                  color: "#1e293b",
                }}
              >
                {Math.round(earned.earnedGrossPay || 0).toLocaleString("en-IN")}
              </td>
            </tr>
          </tbody>
        </table>

        {/* Deductions */}
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "11px",
            height: "fit-content",
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  backgroundColor: BLUE,
                  color: "white",
                  padding: "10px 12px",
                  textAlign: "left",
                  fontWeight: "600",
                  border: `1px solid ${BLUE}`,
                }}
              >
                DEDUCTIONS
              </th>
              <th
                style={{
                  backgroundColor: BLUE,
                  color: "white",
                  padding: "10px 12px",
                  textAlign: "right",
                  fontWeight: "600",
                  border: `1px solid ${BLUE}`,
                }}
              >
                AMOUNT (₹)
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              ["PF", deductions.pfEmployee],
              ["ESIC", deductions.esicEmployee],
              ["Professional Tax", deductions.profTax],
              ["", null],
              ["", null],
              ["", null],
            ].map(([label, amount], i) => (
              <tr key={i}>
                <td
                  style={{
                    padding: "9px 12px",
                    border: cellBorder,
                    color: "#475569",
                  }}
                >
                  {label}
                </td>
                <td
                  style={{
                    padding: "9px 12px",
                    border: cellBorder,
                    textAlign: "right",
                    color: "#1e293b",
                  }}
                >
                  {label
                    ? amount != null && amount > 0
                      ? Math.round(amount).toLocaleString("en-IN")
                      : "NA"
                    : ""}
                </td>
              </tr>
            ))}
            <tr style={{ backgroundColor: "#f1f5f9" }}>
              <td
                style={{
                  padding: "10px 12px",
                  border: cellBorder,
                  fontWeight: "600",
                  color: "#1e293b",
                }}
              >
                Total Deductions
              </td>
              <td
                style={{
                  padding: "10px 12px",
                  border: cellBorder,
                  textAlign: "right",
                  fontWeight: "600",
                  color: "#dc2626",
                }}
              >
                {Math.round(totalDeductions || 0).toLocaleString("en-IN")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Net Pay */}
      <div
        style={{
          margin: "20px 32px 0",
          backgroundColor: BLUE,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 20px",
        }}
      >
        <span style={{ color: "white", fontSize: "13px", fontWeight: "600" }}>
          NET PAY
        </span>
        <span style={{ color: "white", fontSize: "20px", fontWeight: "700" }}>
          ₹{Math.round(netPay || 0).toLocaleString("en-IN")}
        </span>
      </div>

      {/* Signature Section */}
      <div style={{ padding: "40px 32px 24px", marginTop: "auto" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
          }}
        >
          <div>
            <p
              style={{
                fontSize: "11px",
                color: "#64748b",
                marginBottom: "4px",
              }}
            >
              Authorized Signatory -{" "}
              <span style={{ fontWeight: "600", color: "#1e293b" }}>
                Rajvi Pandya
              </span>
            </p>
            <p style={{ fontSize: "10px", color: "#64748b" }}>
              Designation - <span style={{ fontWeight: "500" }}>Head HR</span>
            </p>
          </div>
          <div style={{ textAlign: "center" }}>
            <p
              style={{
                fontSize: "10px",
                color: "#94a3b8",
                marginBottom: "8px",
              }}
            >
              Company Seal
            </p>
            <div
              style={{
                width: "55px",
                height: "55px",
                border: "2px solid #94a3b8",
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#94a3b8",
                fontSize: "8px",
              }}
            >
              SEAL
            </div>
          </div>
        </div>
      </div>

      {/* Footer Bar */}
      <div
        style={{
          backgroundColor: BLUE,
          color: "white",
          padding: "14px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "11px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "14px" }}>📞</span>
          <span>{settings.companyPhone || "+91-9898921290"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "14px" }}>✉️</span>
          <span>{settings.companyEmail || "info@euroasias.com"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "14px" }}>🌐</span>
          <span>{settings.companyWebsite || "www.euroasias.com"}</span>
        </div>
      </div>
    </div>
  );
};

// ─── SETTINGS SECTION ────────────────────────────────────────────────────────
function SettingsSection({ settings, setSettings, notify }) {
  const update = (field, value) => setSettings({ ...settings, [field]: value });

  const handleLogo = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => update("companyLogo", ev.target.result);
    reader.readAsDataURL(file);
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Settings</h2>
        <p className="text-sm text-gray-500 mt-1">
          Configure company details and payroll rules
        </p>
      </div>

      <div className="grid gap-6 max-w-2xl">
        {/* Company Details */}
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Company Details</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">
                Company Name
              </label>
              <input
                type="text"
                value={settings.companyName}
                onChange={(e) => update("companyName", e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">
                Company Logo
              </label>
              <input
                type="file"
                accept="image/*"
                onChange={handleLogo}
                className="text-sm"
              />
              {settings.companyLogo && (
                <div className="mt-2 flex items-center gap-3">
                  <img
                    src={settings.companyLogo}
                    alt="Logo"
                    className="h-10 border rounded"
                  />
                  <button
                    onClick={() => update("companyLogo", "")}
                    className="text-red-500 text-xs"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* PF Settings */}
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Provident Fund</h3>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.pfCeiling}
              onChange={(e) => update("pfCeiling", e.target.checked)}
              className="w-4 h-4 rounded text-blue-600"
            />
            <span className="text-sm text-gray-700">
              Apply PF ceiling (₹15,000 cap on Basic for PF calculation)
            </span>
          </label>
        </div>

        {/* Professional Tax */}
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Professional Tax</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">
                Threshold (₹)
              </label>
              <input
                type="number"
                value={settings.profTaxThreshold}
                onChange={(e) =>
                  update("profTaxThreshold", parseFloat(e.target.value) || 0)
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
              <p className="text-xs text-gray-400 mt-1">
                Tax applies if gross exceeds this
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">
                Amount (₹)
              </label>
              <input
                type="number"
                value={settings.profTaxAmount}
                onChange={(e) =>
                  update("profTaxAmount", parseFloat(e.target.value) || 0)
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>
        </div>

        {/* Data Management */}
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Data Management</h3>
          <p className="text-sm text-gray-500 mb-3">
            All data is stored in your browser's localStorage.
          </p>
          <button
            onClick={() => {
              if (confirm("Export all data as JSON?")) {
                const data = {};
                for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i);
                  if (key.startsWith("payroll_"))
                    data[key] = localStorage.getItem(key);
                }
                const blob = new Blob([JSON.stringify(data, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `payroll_backup_${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                notify("Data exported successfully");
              }
            }}
            className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-200 transition mr-3"
          >
            Export Data (JSON)
          </button>
          <button
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".json";
              input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                  try {
                    const data = JSON.parse(ev.target.result);
                    Object.entries(data).forEach(([key, val]) =>
                      localStorage.setItem(key, val),
                    );
                    notify("Data imported! Please refresh the page.");
                  } catch {
                    notify("Invalid JSON file", "error");
                  }
                };
                reader.readAsText(file);
              };
              input.click();
            }}
            className="bg-blue-50 text-blue-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 transition"
          >
            Import Data (JSON)
          </button>
        </div>
      </div>
    </div>
  );
}
