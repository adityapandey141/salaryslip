import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import jsPDF from "jspdf";
import { toPng } from "html-to-image";
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
    { id: "payroll", label: "Payroll", icon: "📊" },
    { id: "slips", label: "Salary Slips", icon: "📄" },
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
            {tab === "payroll" && (
              <PayrollSection employees={employees} settings={settings} />
            )}
            {tab === "slips" && (
              <SlipSection employees={employees} settings={settings} />
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

// ─── PAYROLL SECTION ─────────────────────────────────────────────────────────
function PayrollSection({ employees, settings }) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth());
  const [year, setYear] = useState(now.getFullYear());
  const [search, setSearch] = useState("");
  const [payroll, setPayroll] = useState({});
  const totalDays = getDaysInMonth(month, year);
  const storageKey = DB.payroll(year, month);

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

  const years = Array.from({ length: 10 }, (_, i) => 2022 + i);

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

  const totals = useMemo(() => {
    let gross = 0,
      net = 0,
      ctcSum = 0;
    filtered.forEach((emp) => {
      const entry = getEntry(emp.id);
      const calc = getFullCalc(
        emp,
        entry.daysAttended,
        totalDays,
        entry.incomeTax,
        settings,
      );
      gross += calc.earned.earnedGrossPay;
      net += calc.netPay;
      ctcSum += calc.ctc;
    });
    return { gross, net, ctcSum };
  }, [filtered, payroll, totalDays, settings]);

  return (
    <div>
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex justify-between items-center flex-wrap gap-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">
              Monthly Payroll
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Enter attendance data — calculations update live
            </p>
          </div>
          <div className="flex items-center gap-3">
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
            <span className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg text-sm font-medium">
              {totalDays} Days
            </span>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search employee..."
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

      {employees.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
          Add employees first to manage payroll
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="max-h-[65vh] overflow-y-auto overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-gray-50 border-b sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-3 font-semibold text-gray-600 min-w-40">
                    Employee
                  </th>
                  <th className="text-center px-3 py-3 font-semibold text-gray-600">
                    Days
                  </th>
                  <th className="text-center px-3 py-3 font-semibold text-gray-600">
                    Leave
                  </th>
                  <th className="text-center px-3 py-3 font-semibold text-gray-600">
                    Tax
                  </th>
                  <th className="text-right px-3 py-3 font-semibold text-gray-600">
                    Gross
                  </th>
                  <th className="text-right px-3 py-3 font-semibold text-gray-600">
                    PF
                  </th>
                  <th className="text-right px-3 py-3 font-semibold text-gray-600">
                    ESIC
                  </th>
                  <th className="text-right px-3 py-3 font-semibold text-gray-600">
                    Prof Tax
                  </th>
                  <th className="text-right px-3 py-3 font-semibold text-green-700">
                    Net Pay
                  </th>
                  <th className="text-right px-3 py-3 font-semibold text-gray-600">
                    CTC
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((emp, i) => {
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
                      className={`border-b last:border-0 hover:bg-blue-50/30 ${i % 2 ? "bg-gray-50/50" : ""}`}
                    >
                      <td className="px-3 py-3">
                        <div className="font-medium text-gray-800">
                          {emp.name}
                        </div>
                        <div className="text-xs text-gray-500">
                          {emp.empCode}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <input
                          type="number"
                          min="0"
                          max={totalDays}
                          value={entry.daysAttended}
                          onChange={(e) =>
                            updateField(emp.id, "daysAttended", e.target.value)
                          }
                          className="w-16 text-center border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <input
                          type="number"
                          min="0"
                          max={totalDays}
                          value={entry.leaveDays}
                          onChange={(e) => {
                            const leaves = parseFloat(e.target.value) || 0;
                            const newEntry = {
                              ...getEntry(emp.id),
                              leaveDays: leaves,
                              daysAttended: Math.max(0, totalDays - leaves),
                            };
                            setPayroll((prev) => ({
                              ...prev,
                              [emp.id]: newEntry,
                            }));
                            savePayrollEntry(
                              emp.id,
                              year,
                              month,
                              newEntry,
                            ).catch(console.error);
                          }}
                          className="w-16 text-center border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <input
                          type="number"
                          min="0"
                          value={entry.incomeTax}
                          onChange={(e) =>
                            updateField(emp.id, "incomeTax", e.target.value)
                          }
                          className="w-20 text-center border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </td>
                      <td className="px-3 py-3 text-right font-medium">
                        {formatINR(calc.earned.earnedGrossPay)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {formatINR(calc.deductions.pfEmployee)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {calc.deductions.esicEmployee != null
                          ? formatINR(calc.deductions.esicEmployee)
                          : "–"}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {formatINR(calc.deductions.profTax)}
                      </td>
                      <td className="px-3 py-3 text-right font-bold text-green-700">
                        {formatINR(calc.netPay)}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-600">
                        {formatINR(calc.ctc)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Summary Row */}
          <div className="border-t bg-gray-50 px-4 py-3 flex justify-end gap-8 text-sm">
            <div className="text-right">
              <span className="text-gray-500">Total Gross:</span>
              <span className="ml-2 font-bold text-gray-800">
                {formatINR(totals.gross)}
              </span>
            </div>
            <div className="text-right">
              <span className="text-gray-500">Total Net Pay:</span>
              <span className="ml-2 font-bold text-green-700">
                {formatINR(totals.net)}
              </span>
            </div>
            <div className="text-right">
              <span className="text-gray-500">Total CTC:</span>
              <span className="ml-2 font-bold text-gray-800">
                {formatINR(totals.ctcSum)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SALARY SLIP SECTION ─────────────────────────────────────────────────────
function SlipSection({ employees, settings }) {
  const now = new Date();
  const [empId, setEmpId] = useState("");
  const [month, setMonth] = useState(now.getMonth());
  const [year, setYear] = useState(now.getFullYear());
  const [search, setSearch] = useState("");
  const [showResults, setShowResults] = useState(false);
  const searchRef = useRef(null);
  const slipRef = useRef(null);

  const totalDays = getDaysInMonth(month, year);
  const employee = employees.find((e) => e.id === empId);

  const payrollData = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(DB.payroll(year, month))) || {};
    } catch {
      return {};
    }
  }, [month, year]);

  const entry = payrollData[empId] || {
    daysAttended: totalDays,
    leaveDays: 0,
    incomeTax: 0,
  };
  const calc = employee
    ? getFullCalc(
        employee,
        entry.daysAttended,
        totalDays,
        entry.incomeTax,
        settings,
      )
    : null;

  const pdfRef = useRef(null);

  const handleDownloadPDF = async () => {
    if (!pdfRef.current) return;
    const element = pdfRef.current;
    const dataUrl = await toPng(element, { pixelRatio: 2, quality: 1 });

    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth(); // 210 mm
    const pageHeight = pdf.internal.pageSize.getHeight(); // 297 mm

    const img = new Image();
    img.src = dataUrl;
    await new Promise((res) => {
      img.onload = res;
    });

    const imgWidth = pageWidth;
    const imgHeight = (img.height * imgWidth) / img.width;

    // Scale to fit entire content on one page
    const scale = imgHeight > pageHeight ? pageHeight / imgHeight : 1;
    const finalWidth = imgWidth * scale;
    const finalHeight = imgHeight * scale;
    const x = (pageWidth - finalWidth) / 2;
    const y = 0;

    pdf.addImage(dataUrl, "PNG", x, y, finalWidth, finalHeight);
    pdf.save(`Salary_Slip_${employee.name}_${MONTHS[month]}_${year}.pdf`);
  };
  const years = Array.from({ length: 10 }, (_, i) => 2022 + i);

  const filtered = useMemo(() => {
    if (!search.trim()) return employees.slice(0, 8);
    const q = search.toLowerCase();
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (e.empCode || "").toLowerCase().includes(q) ||
        (e.department || "").toLowerCase().includes(q),
    );
  }, [employees, search]);

  const selectEmployee = (emp) => {
    setEmpId(emp.id);
    setSearch(emp.name + " (" + emp.empCode + ")");
    setShowResults(false);
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div>
      <div className="flex justify-between items-center mb-6 flex-wrap gap-4 no-print">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Salary Slip</h2>
          <p className="text-sm text-gray-500 mt-1">
            Preview and download salary slips
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Employee Search */}
          <div className="relative" ref={searchRef}>
            <input
              type="text"
              placeholder="Search employee..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShowResults(true);
                if (!e.target.value) setEmpId("");
              }}
              onFocus={() => setShowResults(true)}
              className="border border-gray-300 px-3 py-2 pl-9 rounded-lg text-sm w-64 focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <span className="absolute left-3 top-2.5 text-gray-400 text-sm">
              🔍
            </span>
            {showResults && (
              <div className="absolute top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-60 overflow-y-auto z-20">
                {filtered.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">
                    No employees found
                  </div>
                ) : (
                  filtered.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => selectEmployee(e)}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex justify-between items-center ${e.id === empId ? "bg-blue-50" : ""}`}
                    >
                      <span className="font-medium text-gray-800">
                        {e.name}
                      </span>
                      <span className="text-xs text-gray-500">
                        {e.empCode} • {e.department || "—"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
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
          {employee && calc && (
            <button
              onClick={handleDownloadPDF}
              className="bg-[#1B2A4A] text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-[#243a63] transition shadow-sm"
            >
              ⬇ Download PDF
            </button>
          )}
        </div>
      </div>

      {!employee || !calc ? (
        <div className="bg-white rounded-xl shadow-sm border p-16 text-center text-gray-400 no-print">
          Select an employee and month to preview salary slip
        </div>
      ) : (
        <div className="flex justify-center no-print">
          <div
            ref={pdfRef}
            className="bg-white shadow-lg border rounded-lg overflow-hidden"
            style={{ width: "794px" }}
          >
            <SalarySlipContent
              ref={slipRef}
              employee={employee}
              calc={calc}
              entry={entry}
              month={month}
              year={year}
              totalDays={totalDays}
              settings={settings}
            />
          </div>
        </div>
      )}

      {/* Print-only slip */}
      {employee && calc && (
        <div className="print-slip">
          <SalarySlipContent
            employee={employee}
            calc={calc}
            entry={entry}
            month={month}
            year={year}
            totalDays={totalDays}
            settings={settings}
          />
        </div>
      )}
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
  const { components, earned, deductions, mgmt, totalDeductions, netPay, ctc } =
    calc;
  const emp = employee;

  return (
    <div
      className="p-8 text-[11px] leading-relaxed"
      style={{ fontFamily: "'Inter', sans-serif" }}
    >
      {/* Header */}
      <div className="text-center border-b-2 border-gray-800 pb-4 mb-5">
        {settings.companyLogo && (
          <img
            src={settings.companyLogo}
            alt="Logo"
            className="h-12 mx-auto mb-2"
          />
        )}
        <h1 className="text-xl font-bold text-gray-900 uppercase tracking-wide">
          {settings.companyName}
        </h1>
        <p className="text-sm text-gray-600 mt-1 font-medium">
          Salary Slip — {MONTHS[month]} {year}
        </p>
      </div>

      {/* Employee Details */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 mb-5 text-[12px]">
        <div>
          <span className="text-gray-500">Name:</span>{" "}
          <span className="font-medium">{emp.name}</span>
        </div>
        <div>
          <span className="text-gray-500">Emp Code:</span>{" "}
          <span className="font-medium">{emp.empCode}</span>
        </div>
        <div>
          <span className="text-gray-500">Designation:</span>{" "}
          <span className="font-medium">{emp.designation}</span>
        </div>
        <div>
          <span className="text-gray-500">Department:</span>{" "}
          <span className="font-medium">{emp.department}</span>
        </div>
        <div>
          <span className="text-gray-500">UAN:</span>{" "}
          <span className="font-medium">{emp.uanNo || "–"}</span>
        </div>
        <div>
          <span className="text-gray-500">Bank:</span>{" "}
          <span className="font-medium">{emp.bankName}</span>
        </div>
        <div>
          <span className="text-gray-500">Account No:</span>{" "}
          <span className="font-medium">{emp.accountNo}</span>
        </div>
        <div>
          <span className="text-gray-500">IFSC:</span>{" "}
          <span className="font-medium">{emp.ifscCode}</span>
        </div>
        <div>
          <span className="text-gray-500">Total Days:</span>{" "}
          <span className="font-medium">{totalDays}</span>
        </div>
        <div>
          <span className="text-gray-500">Days Attended:</span>{" "}
          <span className="font-medium">{entry.daysAttended}</span>
        </div>
      </div>

      {/* Earnings Table */}
      <table className="w-full border border-gray-300 mb-4 text-[12px]">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-gray-300 px-3 py-2 text-left font-semibold">
              Earnings
            </th>
            <th className="border border-gray-300 px-3 py-2 text-right font-semibold w-32">
              Actual (₹)
            </th>
            <th className="border border-gray-300 px-3 py-2 text-right font-semibold w-32">
              Earned (₹)
            </th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Basic Salary", components.basic, earned.earnedBasic],
            ["HRA", components.hra, earned.earnedHRA],
            [
              "Conveyance Allowance",
              components.conveyance,
              earned.earnedConveyance,
            ],
            ["Medical Allowance", components.medical, earned.earnedMedical],
            ["Special Allowance", components.special, earned.earnedSpecial],
            ["Bonus", components.bonus, earned.earnedBonus],
          ].map(([label, actual, earnedAmt]) => (
            <tr key={label}>
              <td className="border border-gray-300 px-3 py-1.5">{label}</td>
              <td className="border border-gray-300 px-3 py-1.5 text-right">
                {formatINR(actual)}
              </td>
              <td className="border border-gray-300 px-3 py-1.5 text-right">
                {formatINR(earnedAmt)}
              </td>
            </tr>
          ))}
          <tr className="bg-blue-50 font-semibold">
            <td className="border border-gray-300 px-3 py-1.5">
              Gross PF Pay (Basic+Conv+Special)
            </td>
            <td className="border border-gray-300 px-3 py-1.5 text-right">
              {formatINR(components.pfBase)}
            </td>
            <td className="border border-gray-300 px-3 py-1.5 text-right">
              {formatINR(earned.earnedPFBase)}
            </td>
          </tr>
          <tr className="bg-gray-100 font-bold">
            <td className="border border-gray-300 px-3 py-2">GROSS PAY</td>
            <td className="border border-gray-300 px-3 py-2 text-right">
              {formatINR(components.grossPay)}
            </td>
            <td className="border border-gray-300 px-3 py-2 text-right">
              {formatINR(earned.earnedGrossPay)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Deductions Table */}
      <table className="w-full border border-gray-300 mb-4 text-[12px]">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-gray-300 px-3 py-2 text-left font-semibold">
              Deductions
            </th>
            <th className="border border-gray-300 px-3 py-2 text-right font-semibold w-32">
              Amount (₹)
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border border-gray-300 px-3 py-1.5">
              P.F. Employee (12%)
            </td>
            <td className="border border-gray-300 px-3 py-1.5 text-right">
              {formatINR(deductions.pfEmployee)}
            </td>
          </tr>
          <tr>
            <td className="border border-gray-300 px-3 py-1.5">
              ESIC Employee (0.75%)
            </td>
            <td className="border border-gray-300 px-3 py-1.5 text-right">
              {deductions.esicEmployee != null
                ? formatINR(deductions.esicEmployee)
                : "–"}
            </td>
          </tr>
          <tr>
            <td className="border border-gray-300 px-3 py-1.5">
              Professional Tax
            </td>
            <td className="border border-gray-300 px-3 py-1.5 text-right">
              {formatINR(deductions.profTax)}
            </td>
          </tr>
          <tr>
            <td className="border border-gray-300 px-3 py-1.5">Income Tax</td>
            <td className="border border-gray-300 px-3 py-1.5 text-right">
              {formatINR(entry.incomeTax || 0)}
            </td>
          </tr>
          <tr>
            <td className="border border-gray-300 px-3 py-1.5">
              P.F. Employer (12%)
            </td>
            <td className="border border-gray-300 px-3 py-1.5 text-right">
              {formatINR(mgmt.pfManagement)}
            </td>
          </tr>
          <tr>
            <td className="border border-gray-300 px-3 py-1.5">
              ESIC Employer (3.25%)
            </td>
            <td className="border border-gray-300 px-3 py-1.5 text-right">
              {mgmt.esicManagement != null
                ? formatINR(mgmt.esicManagement)
                : "–"}
            </td>
          </tr>
          <tr className="bg-gray-100 font-bold">
            <td className="border border-gray-300 px-3 py-2">
              Total Deductions
            </td>
            <td className="border border-gray-300 px-3 py-2 text-right">
              {formatINR(totalDeductions)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Net Pay */}
      <div className="bg-green-50 border-2 border-green-600 rounded-lg px-4 py-3 flex justify-between items-center mb-4">
        <span className="font-bold text-green-800 text-base">NET PAY</span>
        <span className="font-bold text-green-800 text-lg">
          {formatINR(netPay)}
        </span>
      </div>

      {/* CTC */}
      <div className="bg-blue-50 border border-blue-300 rounded-lg px-4 py-2 flex justify-between items-center mb-6 text-sm">
        <span className="font-semibold text-blue-800">
          CTC (Cost to Company)
        </span>
        <span className="font-semibold text-blue-800">{formatINR(ctc)}</span>
      </div>

      {/* Footer */}
      <div className="border-t-2 border-gray-300 pt-4 mt-8">
        <div className="flex justify-between items-end">
          <div>
            <p className="text-gray-500 text-[11px]">
              This is a system-generated document.
            </p>
            <p className="font-medium text-gray-700 mt-1">
              For {settings.companyName}
            </p>
          </div>
          <div className="text-right">
            <img
              src="/sign.png"
              alt="Signature"
              className="h-12 ml-auto mb-1"
            />
            <div className="w-36 border-t border-gray-400 pt-1">
              <p className="text-[11px] text-gray-500">Authorized Signatory</p>
            </div>
          </div>
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
