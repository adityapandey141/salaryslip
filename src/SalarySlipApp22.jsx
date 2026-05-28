import { useState, useEffect, useMemo, useRef } from "react";

const KEYS = {
  employees: "hrapp_employees",
  settings: "hrapp_settings",
  credentials: "hrapp_credentials",
  payrollPrefix: "hrapp_payroll_",
};

const loadScripts = () => {
  const scripts = [
    {
      src: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
      id: "jspdf",
    },
    {
      src: "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
      id: "h2c",
    },
    {
      src: "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js",
      id: "ejs",
    },
  ];
  scripts.forEach(({ src, id }) => {
    if (!document.getElementById(id)) {
      const s = document.createElement("script");
      s.src = src;
      s.id = id;
      s.async = true;
      document.head.appendChild(s);
    }
  });
};

const formatINR = (n) =>
  n == null || isNaN(n) ? "₹0" : "₹" + Math.round(n).toLocaleString("en-IN");
const getDaysInMonth = (m, y) => new Date(y, m + 1, 0).getDate();
const monthNames = [
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
const encode = (s) => btoa(s);
const decode = (s) => {
  try {
    return atob(s);
  } catch {
    return "";
  }
};

const calcComponents = (payScale) => {
  const basic = Math.round(payScale * 0.5);
  const hra = Math.round(basic * 0.4);
  const conveyance = 1600,
    medical = 2500;
  const bonus = Math.round(basic * 0.0833);
  const special = payScale - (basic + hra + conveyance + medical + bonus);
  const grossPayPF = basic + hra + conveyance + medical + special;
  return {
    basic,
    hra,
    conveyance,
    medical,
    bonus,
    special,
    grossPayPF,
    grossPay: payScale,
  };
};

const calcEarned = (c, effDays, totalDays) => {
  const r = effDays / totalDays;
  const earnedBasic = Math.round(c.basic * r);
  const earnedHRA = Math.round(c.hra * r);
  const earnedConveyance = Math.round(c.conveyance * r);
  const earnedMedical = Math.round(c.medical * r);
  const earnedSpecial = Math.round(c.special * r);
  const earnedBonus = Math.round(c.bonus * r);
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
    earnedGrossPayPF,
    earnedGrossPay,
  };
};

const calcDeductions = (earned, emp, settings) => {
  const pfBase =
    settings.pfCeiling && earned.earnedGrossPayPF > 15000
      ? 15000
      : earned.earnedBasic;
  const pfEmployee = Math.round(pfBase * 0.12);
  let esicEmployee = null;
  if (emp.esicApplicable && earned.earnedGrossPay <= 21000)
    esicEmployee = Math.round(earned.earnedGrossPay * 0.0075);
  const profTax =
    earned.earnedGrossPay > settings.profTaxThreshold
      ? settings.profTaxAmount
      : 0;
  return { pfEmployee, esicEmployee, profTax };
};

const calcMgmt = (earned, emp) => {
  const pfManagement = Math.round(earned.earnedBasic * 0.12);
  let esicManagement = null;
  if (emp.esicApplicable && earned.earnedGrossPay <= 21000)
    esicManagement = Math.round(earned.earnedGrossPay * 0.0325);
  return { pfManagement, esicManagement };
};

const defaultSettings = {
  companyName: "Your Company Name",
  companyLogo: "",
  pfCeiling: true,
  profTaxThreshold: 10000,
  profTaxAmount: 200,
  signatoryName: "",
  signatoryDesignation: "HR Manager",
  signatureImage: "",
  sealImage: "",
  emailServiceId: "",
  emailTemplateId: "",
  emailPublicKey: "",
  emailSenderName: "",
};

const defaultEmployee = {
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
  email: "",
};

const defaultAttendance = {
  presentDays: 0,
  halfDays: 0,
  paidLeave: 0,
  lopDays: 0,
  incomeTax: 0,
};

const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      className={`fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg text-white z-50 ${type === "success" ? "bg-green-600" : "bg-red-600"}`}
    >
      {message}
    </div>
  );
};

export default function SalarySlipApp() {
  const [authState, setAuthState] = useState("loading");
  const [toast, setToast] = useState(null);

  useEffect(() => {
    loadScripts();
    const creds = localStorage.getItem(KEYS.credentials);
    const session = sessionStorage.getItem("hrapp_session");
    if (!creds) setAuthState("setup");
    else if (session === "active") setAuthState("authenticated");
    else setAuthState("login");
  }, []);

  const showToast = (message, type = "success") => setToast({ message, type });

  if (authState === "loading")
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <div className="text-lg text-gray-500">Loading...</div>
      </div>
    );
  if (authState === "setup")
    return <SetupScreen onComplete={() => setAuthState("login")} />;
  if (authState === "login")
    return (
      <LoginScreen
        onSuccess={() => {
          sessionStorage.setItem("hrapp_session", "active");
          setAuthState("authenticated");
        }}
      />
    );

  return (
    <>
      <MainApp
        onLogout={() => {
          sessionStorage.removeItem("hrapp_session");
          setAuthState("login");
        }}
        showToast={showToast}
      />
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}

function SetupScreen({ onComplete }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const handleSetup = (e) => {
    e.preventDefault();
    if (password.length < 4) {
      setError("Password must be at least 4 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    localStorage.setItem(
      KEYS.credentials,
      JSON.stringify({ u: encode(username), p: encode(password) }),
    );
    onComplete();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center text-slate-800 mb-2">
          HR Payroll System
        </h1>
        <p className="text-center text-gray-500 mb-6">
          First-time setup: Create your HR account
        </p>
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}
        <form onSubmit={handleSetup} className="space-y-4">
          <input
            type="text"
            placeholder="Username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <input
            type="password"
            placeholder="Confirm Password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            type="submit"
            className="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
          >
            Create Account
          </button>
        </form>
      </div>
    </div>
  );
}

function LoginScreen({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleLogin = (e) => {
    e.preventDefault();
    const creds = JSON.parse(localStorage.getItem(KEYS.credentials) || "{}");
    if (decode(creds.u) === username && decode(creds.p) === password)
      onSuccess();
    else setError("Invalid username or password");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center text-slate-800 mb-2">
          HR Payroll System
        </h1>
        <p className="text-center text-gray-500 mb-6">Sign in to continue</p>
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}
        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="text"
            placeholder="Username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            type="submit"
            className="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
          >
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}

function MainApp({ onLogout, showToast }) {
  const [activeTab, setActiveTab] = useState("employees");
  const [employees, setEmployees] = useState(() => {
    const saved = localStorage.getItem(KEYS.employees);
    return saved ? JSON.parse(saved) : [];
  });
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem(KEYS.settings);
    return saved
      ? { ...defaultSettings, ...JSON.parse(saved) }
      : defaultSettings;
  });
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [showEmployeeForm, setShowEmployeeForm] = useState(false);

  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [slipEmployee, setSlipEmployee] = useState("");
  const [slipMonth, setSlipMonth] = useState(now.getMonth());
  const [slipYear, setSlipYear] = useState(now.getFullYear());

  const payrollKey = `${KEYS.payrollPrefix}${selectedYear}_${String(selectedMonth).padStart(2, "0")}`;
  const totalDays = getDaysInMonth(selectedMonth, selectedYear);

  const [payrollData, setPayrollData] = useState(() => {
    const saved = localStorage.getItem(payrollKey);
    return saved ? JSON.parse(saved) : {};
  });

  useEffect(() => {
    localStorage.setItem(KEYS.employees, JSON.stringify(employees));
  }, [employees]);
  useEffect(() => {
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    localStorage.setItem(payrollKey, JSON.stringify(payrollData));
  }, [payrollData, payrollKey]);

  useEffect(() => {
    const saved = localStorage.getItem(payrollKey);
    setPayrollData(saved ? JSON.parse(saved) : {});
  }, [payrollKey]);

  const currentPayroll = useMemo(() => {
    const result = {};
    employees.forEach((emp) => {
      result[emp.id] = payrollData[emp.id] || {
        ...defaultAttendance,
        presentDays: totalDays,
      };
    });
    return result;
  }, [employees, payrollData, totalDays]);

  const updatePayrollEntry = (empId, field, value) => {
    const numValue = parseFloat(value) || 0;
    setPayrollData((prev) => ({
      ...prev,
      [empId]: { ...currentPayroll[empId], [field]: numValue },
    }));
  };

  const saveEmployee = (data) => {
    if (editingEmployee) {
      setEmployees(
        employees.map((e) =>
          e.id === editingEmployee.id ? { ...data, id: editingEmployee.id } : e,
        ),
      );
    } else {
      setEmployees([...employees, { ...data, id: Date.now().toString() }]);
    }
    setShowEmployeeForm(false);
    setEditingEmployee(null);
  };

  const deleteEmployee = (id) => {
    if (confirm("Delete this employee?"))
      setEmployees(employees.filter((e) => e.id !== id));
  };

  const getCalc = (emp, entry, days) => {
    const effectiveDays =
      (entry.presentDays || 0) +
      (entry.halfDays || 0) * 0.5 +
      (entry.paidLeave || 0);
    const components = calcComponents(emp.payScale);
    const earned = calcEarned(components, effectiveDays, days);
    const deductions = calcDeductions(earned, emp, settings);
    const mgmt = calcMgmt(earned, emp);
    const totalDeductions =
      deductions.pfEmployee +
      (deductions.esicEmployee || 0) +
      deductions.profTax +
      (entry.incomeTax || 0);
    const netPay = earned.earnedGrossPay - totalDeductions;
    const ctc =
      earned.earnedGrossPay + mgmt.pfManagement + (mgmt.esicManagement || 0);
    return {
      components,
      earned,
      deductions,
      mgmt,
      totalDeductions,
      netPay,
      ctc,
      effectiveDays,
    };
  };

  const years = Array.from({ length: 11 }, (_, i) => 2020 + i);

  return (
    <div
      className="min-h-screen bg-gray-100"
      style={{ fontFamily: "Inter, system-ui, sans-serif" }}
    >
      <nav className="bg-[#1E3A5F] text-white p-4 shadow-lg">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-semibold">HR Payroll System</h1>
          <div className="flex items-center gap-3">
            {["employees", "payroll", "slip", "settings"].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${activeTab === tab ? "bg-white text-[#1E3A5F]" : "bg-[#2d5a87] hover:bg-[#3d6a97]"}`}
              >
                {tab === "employees"
                  ? "Employees"
                  : tab === "payroll"
                    ? "Payroll"
                    : tab === "slip"
                      ? "Salary Slip"
                      : "Settings"}
              </button>
            ))}
            <button
              onClick={onLogout}
              className="ml-4 px-4 py-2 bg-red-500 hover:bg-red-600 rounded-lg text-sm font-medium transition"
            >
              Logout
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-6">
        {activeTab === "employees" && (
          <EmployeeSection
            employees={employees}
            showForm={showEmployeeForm}
            setShowForm={setShowEmployeeForm}
            editingEmployee={editingEmployee}
            setEditingEmployee={setEditingEmployee}
            saveEmployee={saveEmployee}
            deleteEmployee={deleteEmployee}
          />
        )}
        {activeTab === "payroll" && (
          <PayrollSection
            employees={employees}
            selectedMonth={selectedMonth}
            setSelectedMonth={setSelectedMonth}
            selectedYear={selectedYear}
            setSelectedYear={setSelectedYear}
            totalDays={totalDays}
            currentPayroll={currentPayroll}
            updatePayrollEntry={updatePayrollEntry}
            getCalc={getCalc}
            years={years}
          />
        )}
        {activeTab === "slip" && (
          <SlipSection
            employees={employees}
            slipEmployee={slipEmployee}
            setSlipEmployee={setSlipEmployee}
            slipMonth={slipMonth}
            setSlipMonth={setSlipMonth}
            slipYear={slipYear}
            setSlipYear={setSlipYear}
            settings={settings}
            years={years}
            showToast={showToast}
            payrollKey={`${KEYS.payrollPrefix}${slipYear}_${String(slipMonth).padStart(2, "0")}`}
          />
        )}
        {activeTab === "settings" && (
          <SettingsSection settings={settings} setSettings={setSettings} />
        )}
      </main>
    </div>
  );
}

function EmployeeSection({ employees, showForm, setShowForm, editingEmployee, setEditingEmployee, saveEmployee, deleteEmployee }) {
  const [formData, setFormData] = useState(defaultEmployee);
  useEffect(() => { setFormData(editingEmployee || defaultEmployee); }, [editingEmployee]);

  const handleSubmit = (e) => { e.preventDefault(); saveEmployee(formData); setFormData(defaultEmployee); };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-semibold text-gray-800">Employee Master</h2>
        <button onClick={() => { setShowForm(true); setEditingEmployee(null); }}
          className="bg-[#1E3A5F] text-white px-5 py-2 rounded-lg hover:bg-[#2d5a87] transition font-medium">
          + Add Employee
        </button>
      </div>

      {showForm && (
        <div className="bg-white p-6 rounded-xl shadow-md mb-6 border border-gray-200">
          <h3 className="text-lg font-semibold mb-4 text-gray-700">{editingEmployee ? 'Edit Employee' : 'Add New Employee'}</h3>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <input type="text" placeholder="Name *" required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="text" placeholder="Employee Code *" required value={formData.empCode} onChange={e => setFormData({ ...formData, empCode: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="email" placeholder="Email Address" value={formData.email || ''} onChange={e => setFormData({ ...formData, email: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="text" placeholder="Designation" value={formData.designation} onChange={e => setFormData({ ...formData, designation: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="text" placeholder="Department" value={formData.department} onChange={e => setFormData({ ...formData, department: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="text" placeholder="UAN No." value={formData.uanNo} onChange={e => setFormData({ ...formData, uanNo: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="text" placeholder="ESIC No." value={formData.esicNo} onChange={e => setFormData({ ...formData, esicNo: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="text" placeholder="Bank Name" value={formData.bankName} onChange={e => setFormData({ ...formData, bankName: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="text" placeholder="Account No." value={formData.accountNo} onChange={e => setFormData({ ...formData, accountNo: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="text" placeholder="IFSC Code" value={formData.ifscCode} onChange={e => setFormData({ ...formData, ifscCode: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="date" value={formData.dateOfJoining} onChange={e => setFormData({ ...formData, dateOfJoining: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <input type="number" placeholder="Pay Scale (₹) *" required value={formData.payScale || ''} onChange={e => setFormData({ ...formData, payScale: parseFloat(e.target.value) || 0 })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            <label className="flex items-center gap-3 p-3">
              <input type="checkbox" checked={formData.esicApplicable} onChange={e => setFormData({ ...formData, esicApplicable: e.target.checked })} className="w-5 h-5 rounded" />
              <span className="text-gray-700">ESIC Applicable</span>
            </label>
            <div className="md:col-span-3 lg:col-span-4 flex gap-3 pt-2">
              <button type="submit" className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 font-medium transition">
                {editingEmployee ? 'Update' : 'Save'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditingEmployee(null); }}
                className="bg-gray-500 text-white px-6 py-2 rounded-lg hover:bg-gray-600 font-medium transition">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-md overflow-hidden border border-gray-200">
        <table className="w-full">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Code</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Name</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Email</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Designation</th>
              <th className="px-4 py-3 text-right text-sm font-semibold text-gray-600">Pay Scale</th>
              <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600">ESIC</th>
              <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 ? (
              <tr><td colSpan="7" className="px-4 py-12 text-center text-gray-400">No employees added yet</td></tr>
            ) : employees.map((emp, i) => (
              <tr key={emp.id} className={`border-t hover:bg-blue-50 transition ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                <td className="px-4 py-3 text-sm font-medium text-gray-800">{emp.empCode}</td>
                <td className="px-4 py-3 text-sm">{emp.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{emp.email || '–'}</td>
                <td className="px-4 py-3 text-sm">{emp.designation || '–'}</td>
                <td className="px-4 py-3 text-sm text-right font-medium">{formatINR(emp.payScale)}</td>
                <td className="px-4 py-3 text-sm text-center">{emp.esicApplicable ? <span className="text-green-600">Yes</span> : <span className="text-gray-400">No</span>}</td>
                <td className="px-4 py-3 text-sm text-center">
                  <button onClick={() => { setEditingEmployee(emp); setShowForm(true); }} className="text-blue-600 hover:underline mr-3">Edit</button>
                  <button onClick={() => deleteEmployee(emp.id)} className="text-red-600 hover:underline">Delete</button>
                  </td>
                  <td className="px-4 py-3 text-sm text-center">
                    <button
                      onClick={() => startEdit(emp)}
                      className="text-blue-600 hover:underline mr-3"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteEmployee(emp.id)}
                      className="text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PayrollSection({
  employees,
  selectedMonth,
  setSelectedMonth,
  selectedYear,
  setSelectedYear,
  totalDays,
  currentPayroll,
  updatePayrollEntry,
  getFullPayrollCalculation,
  bulkGenerateSlips,
  monthNames,
  years,
}) {
  return (
    <div className="no-print">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Monthly Payroll</h2>
        <div className="flex gap-4 items-center">
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
            className="border p-2 rounded"
          >
            {monthNames.map((m, i) => (
              <option key={i} value={i}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(parseInt(e.target.value))}
            className="border p-2 rounded"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <span className="text-gray-600">
            Total Days: <strong>{totalDays}</strong>
          </span>
          <button
            onClick={bulkGenerateSlips}
            className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
          >
            Bulk Generate
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left font-semibold text-gray-600">
                Employee
              </th>
              <th className="px-3 py-3 text-center font-semibold text-gray-600">
                Days Attended
              </th>
              <th className="px-3 py-3 text-center font-semibold text-gray-600">
                Leave Days
              </th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">
                Income Tax (₹)
              </th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">
                Earned Gross
              </th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">
                PF Emp
              </th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">
                ESIC Emp
              </th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">
                Prof Tax
              </th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">
                Net Pay
              </th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">
                CTC
              </th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 ? (
              <tr>
                <td
                  colSpan="10"
                  className="px-4 py-8 text-center text-gray-500"
                >
                  No employees. Add employees first.
                </td>
              </tr>
            ) : (
              employees.map((emp) => {
                const entry = currentPayroll[emp.id] || {
                  daysAttended: totalDays,
                  leaveDays: 0,
                  incomeTax: 0,
                };
                const calc = getFullPayrollCalculation(emp, entry);

                return (
                  <tr key={emp.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-3 font-medium">
                      {emp.name}
                      <br />
                      <span className="text-xs text-gray-500">
                        {emp.empCode}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <input
                        type="number"
                        min="0"
                        max={totalDays}
                        value={entry.daysAttended}
                        onChange={(e) =>
                          updatePayrollEntry(
                            emp.id,
                            "daysAttended",
                            e.target.value,
                          )
                        }
                        className="w-16 border p-1 rounded text-center"
                      />
                    </td>
                    <td className="px-3 py-3 text-center">
                      <input
                        type="number"
                        min="0"
                        max={totalDays}
                        value={entry.leaveDays}
                        onChange={(e) =>
                          updatePayrollEntry(
                            emp.id,
                            "leaveDays",
                            e.target.value,
                          )
                        }
                        className="w-16 border p-1 rounded text-center"
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <input
                        type="number"
                        min="0"
                        value={entry.incomeTax || ""}
                        onChange={(e) =>
                          updatePayrollEntry(
                            emp.id,
                            "incomeTax",
                            e.target.value,
                          )
                        }
                        className="w-20 border p-1 rounded text-right"
                        placeholder="0"
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      {formatINR(calc.earned.earnedGrossPay)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {formatINR(calc.deductions.pfEmployee)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {calc.deductions.esicEmployee !== null
                        ? formatINR(calc.deductions.esicEmployee)
                        : "–"}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {formatINR(calc.deductions.profTax)}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold text-green-700">
                      {formatINR(calc.netPay)}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold">
                      {formatINR(calc.ctc)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SlipSection({
  employees,
  slipEmployee,
  setSlipEmployee,
  slipMonth,
  setSlipMonth,
  slipYear,
  setSlipYear,
  payrollData,
  settings,
  printSlip,
  monthNames,
  years,
}) {
  const slipKey = `${slipMonth}-${slipYear}`;
  const totalDays = getDaysInMonth(slipMonth, slipYear);
  const employee = employees.find((e) => e.id === slipEmployee);
  const payrollEntry = payrollData[slipKey]?.[slipEmployee] || {
    daysAttended: totalDays,
    leaveDays: 0,
    incomeTax: 0,
  };

  let slipData = null;
  if (employee) {
    const components = calculateSalaryComponents(employee.payScale);
    const earned = calculateEarnedComponents(
      components,
      payrollEntry.daysAttended,
      totalDays,
    );
    const deductions = calculateDeductions(earned, employee, settings);
    const management = calculateManagementContributions(earned, employee);
    const totalDeductions =
      deductions.pfEmployee +
      (deductions.esicEmployee || 0) +
      deductions.profTax +
      (payrollEntry.incomeTax || 0);
    const netPay = earned.earnedGrossPay - totalDeductions;
    const ctc =
      earned.earnedGrossPay +
      management.pfManagement +
      (management.esicManagement || 0);

    slipData = {
      components,
      earned,
      deductions,
      management,
      totalDeductions,
      netPay,
      ctc,
      payrollEntry,
      totalDays,
    };
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6 no-print">
        <h2 className="text-2xl font-bold text-gray-800">Salary Slip Viewer</h2>
        <div className="flex gap-4 items-center">
          <select
            value={slipEmployee}
            onChange={(e) => setSlipEmployee(e.target.value)}
            className="border p-2 rounded min-w-48"
          >
            <option value="">Select Employee</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.empCode})
              </option>
            ))}
          </select>
          <select
            value={slipMonth}
            onChange={(e) => setSlipMonth(parseInt(e.target.value))}
            className="border p-2 rounded"
          >
            {monthNames.map((m, i) => (
              <option key={i} value={i}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={slipYear}
            onChange={(e) => setSlipYear(parseInt(e.target.value))}
            className="border p-2 rounded"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          {employee && (
            <button
              onClick={printSlip}
              className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
            >
              Download PDF
            </button>
          )}
        </div>
      </div>

      {!employee ? (
        <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500 no-print">
          Select an employee to preview salary slip
        </div>
      ) : (
        <div className="print-area bg-white rounded-lg shadow p-8 max-w-3xl mx-auto">
          <div className="text-center mb-6 border-b pb-4">
            {settings.companyLogo && (
              <img
                src={settings.companyLogo}
                alt="Logo"
                className="h-16 mx-auto mb-2"
              />
            )}
            <h2 className="text-xl font-bold text-gray-800">
              {settings.companyName}
            </h2>
            <p className="text-lg font-semibold text-indigo-600">
              Salary Slip – {monthNames[slipMonth]} {slipYear}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6 text-sm border-b pb-4">
            <div>
              <span className="text-gray-500">Name:</span>{" "}
              <strong>{employee.name}</strong>
            </div>
            <div>
              <span className="text-gray-500">Emp Code:</span>{" "}
              <strong>{employee.empCode}</strong>
            </div>
            <div>
              <span className="text-gray-500">Designation:</span>{" "}
              <strong>{employee.designation || "–"}</strong>
            </div>
            <div>
              <span className="text-gray-500">Department:</span>{" "}
              <strong>{employee.department || "–"}</strong>
            </div>
            <div>
              <span className="text-gray-500">UAN:</span>{" "}
              <strong>{employee.uanNo || "–"}</strong>
            </div>
            <div>
              <span className="text-gray-500">Bank:</span>{" "}
              <strong>{employee.bankName || "–"}</strong>
            </div>
            <div>
              <span className="text-gray-500">Account No:</span>{" "}
              <strong>{employee.accountNo || "–"}</strong>
            </div>
            <div>
              <span className="text-gray-500">IFSC:</span>{" "}
              <strong>{employee.ifscCode || "–"}</strong>
            </div>
            <div>
              <span className="text-gray-500">Total Days:</span>{" "}
              <strong>{slipData.totalDays}</strong>
            </div>
            <div>
              <span className="text-gray-500">Days Attended:</span>{" "}
              <strong>{slipData.payrollEntry.daysAttended}</strong>
            </div>
          </div>

          <div className="mb-6">
            <h3 className="font-bold text-gray-700 mb-2 bg-gray-100 px-3 py-2">
              EARNINGS
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3">Component</th>
                  <th className="text-right py-2 px-3">Actual</th>
                  <th className="text-right py-2 px-3">Earned</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b">
                  <td className="py-2 px-3">Basic Salary</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.components.basic)}
                  </td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.earned.earnedBasic)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">HRA</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.components.hra)}
                  </td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.earned.earnedHRA)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">Conveyance</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.components.conveyance)}
                  </td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.earned.earnedConveyance)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">Medical Allowance</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.components.medical)}
                  </td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.earned.earnedMedical)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">Special Allowance</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.components.special)}
                  </td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.earned.earnedSpecial)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">Bonus (8.33%)</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.components.bonus)}
                  </td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.earned.earnedBonus)}
                  </td>
                </tr>
                <tr className="border-b bg-gray-50">
                  <td className="py-2 px-3 font-semibold">GROSS PAY PF</td>
                  <td className="text-right py-2 px-3 font-semibold">
                    {formatINR(slipData.components.grossPayPF)}
                  </td>
                  <td className="text-right py-2 px-3 font-semibold">
                    {formatINR(slipData.earned.earnedGrossPayPF)}
                  </td>
                </tr>
                <tr className="bg-indigo-50">
                  <td className="py-2 px-3 font-bold">GROSS PAY</td>
                  <td className="text-right py-2 px-3 font-bold">
                    {formatINR(slipData.components.grossPay)}
                  </td>
                  <td className="text-right py-2 px-3 font-bold">
                    {formatINR(slipData.earned.earnedGrossPay)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mb-6">
            <h3 className="font-bold text-gray-700 mb-2 bg-gray-100 px-3 py-2">
              DEDUCTIONS
            </h3>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b">
                  <td className="py-2 px-3">P.F. Employee (12%)</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.deductions.pfEmployee)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">ESIC Employee (0.75%)</td>
                  <td className="text-right py-2 px-3">
                    {slipData.deductions.esicEmployee !== null
                      ? formatINR(slipData.deductions.esicEmployee)
                      : "–"}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">Professional Tax</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.deductions.profTax)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">Income Tax</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.payrollEntry.incomeTax || 0)}
                  </td>
                </tr>
                <tr className="bg-red-50">
                  <td className="py-2 px-3 font-bold">Total Deductions</td>
                  <td className="text-right py-2 px-3 font-bold text-red-600">
                    {formatINR(slipData.totalDeductions)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mb-6 bg-green-100 p-4 rounded">
            <div className="flex justify-between items-center text-lg">
              <span className="font-bold">NET PAY</span>
              <span className="font-bold text-green-700 text-xl">
                {formatINR(slipData.netPay)}
              </span>
            </div>
            <div className="flex justify-between items-center mt-2 text-sm text-gray-600">
              <span>CTC (Cost to Company)</span>
              <span className="font-semibold">{formatINR(slipData.ctc)}</span>
            </div>
          </div>

          <div className="mb-6">
            <h3 className="font-bold text-gray-700 mb-2 bg-gray-100 px-3 py-2">
              MANAGEMENT CONTRIBUTIONS
            </h3>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b">
                  <td className="py-2 px-3">P.F. Management (12%)</td>
                  <td className="text-right py-2 px-3">
                    {formatINR(slipData.management.pfManagement)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3">ESIC Management (3.25%)</td>
                  <td className="text-right py-2 px-3">
                    {slipData.management.esicManagement !== null
                      ? formatINR(slipData.management.esicManagement)
                      : "–"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="border-t pt-6 mt-6">
            <div className="flex justify-between items-end text-sm">
              <div>
                <p className="text-gray-500">For {settings.companyName}</p>
              </div>
              <div className="text-right">
                <div className="border-b border-gray-400 w-48 mb-1"></div>
                <p className="text-gray-500">HR Manager Signature</p>
                <p className="text-gray-400 text-xs mt-1">
                  Date: _______________
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsSection({ settings, setSettings, handleLogoUpload }) {
  return (
    <div className="no-print max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">App Settings</h2>

      <div className="bg-white rounded-lg shadow p-6 space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Company Name
          </label>
          <input
            type="text"
            value={settings.companyName}
            onChange={(e) =>
              setSettings({ ...settings, companyName: e.target.value })
            }
            className="w-full border p-3 rounded"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Company Logo
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={handleLogoUpload}
            className="border p-2 rounded w-full"
          />
          {settings.companyLogo && (
            <div className="mt-3 flex items-center gap-4">
              <img
                src={settings.companyLogo}
                alt="Logo preview"
                className="h-16 border p-1 rounded"
              />
              <button
                onClick={() => setSettings({ ...settings, companyLogo: "" })}
                className="text-red-600 hover:underline text-sm"
              >
                Remove Logo
              </button>
            </div>
          )}
        </div>

        <div className="border-t pt-6">
          <h3 className="font-semibold text-gray-700 mb-4">PF Settings</h3>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.pfCeiling}
              onChange={(e) =>
                setSettings({ ...settings, pfCeiling: e.target.checked })
              }
              className="w-5 h-5"
            />
            <span>Apply ₹15,000 ceiling for PF calculation</span>
          </label>
        </div>

        <div className="border-t pt-6">
          <h3 className="font-semibold text-gray-700 mb-4">
            Professional Tax Settings
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Threshold (₹)
              </label>
              <input
                type="number"
                value={settings.profTaxThreshold}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    profTaxThreshold: parseFloat(e.target.value) || 0,
                  })
                }
                className="w-full border p-2 rounded"
              />
              <p className="text-xs text-gray-500 mt-1">
                Tax applies if earned gross exceeds this
              </p>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Tax Amount (₹)
              </label>
              <input
                type="number"
                value={settings.profTaxAmount}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    profTaxAmount: parseFloat(e.target.value) || 0,
                  })
                }
                className="w-full border p-2 rounded"
              />
            </div>
          </div>
        </div>

        <div className="border-t pt-6 text-sm text-gray-500">
          <p>All settings are automatically saved to localStorage.</p>
        </div>
      </div>
    </div>
  );
}
