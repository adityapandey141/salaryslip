import { useState, useEffect, useMemo, useRef, useCallback } from "react";

const KEYS = {
  employees: "hrapp_employees",
  settings: "hrapp_settings",
  credentials: "hrapp_credentials",
  payrollPrefix: "hrapp_payroll_",
};

const loadScripts = () => {
  [
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
  ].forEach(({ src, id }) => {
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
const encode = (s) => btoa(encodeURIComponent(s));
const decode = (s) => {
  try {
    return decodeURIComponent(atob(s));
  } catch {
    return "";
  }
};

const calcComponents = (payScale) => {
  const basic = Math.round(payScale * 0.5),
    hra = Math.round(basic * 0.4),
    conveyance = 1600,
    medical = 2500;
  const bonus = Math.round(basic * 0.0833),
    special = payScale - (basic + hra + conveyance + medical + bonus);
  return {
    basic,
    hra,
    conveyance,
    medical,
    bonus,
    special,
    grossPayPF: basic + hra + conveyance + medical + special,
    grossPay: payScale,
  };
};

const calcEarned = (c, paidDays, totalDays) => {
  const payRatio =
    totalDays > 0 ? Math.min(1, Math.max(0, paidDays / totalDays)) : 0;
  const earnedBasic = Math.round(c.basic * payRatio),
    earnedHRA = Math.round(c.hra * payRatio),
    earnedConveyance = Math.round(c.conveyance * payRatio);
  const earnedMedical = Math.round(c.medical * payRatio),
    earnedSpecial = Math.round(c.special * payRatio),
    earnedBonus = Math.round(c.bonus * payRatio);
  const earnedGrossPayPF =
    earnedBasic + earnedHRA + earnedConveyance + earnedMedical + earnedSpecial;
  return {
    earnedBasic,
    earnedHRA,
    earnedConveyance,
    earnedMedical,
    earnedSpecial,
    earnedBonus,
    earnedGrossPayPF,
    earnedGrossPay: earnedGrossPayPF + earnedBonus,
    payRatio,
  };
};

const calcDeductions = (earned, emp, settings) => {
  const pfBase =
    settings.pfCeiling && earned.earnedGrossPayPF > 15000
      ? 15000
      : earned.earnedBasic;
  const pfEmployee = Math.round(pfBase * 0.12);
  const esicEmployee =
    emp.esicApplicable && earned.earnedGrossPay <= 21000
      ? Math.round(earned.earnedGrossPay * 0.0075)
      : null;
  const profTax =
    earned.earnedGrossPay > settings.profTaxThreshold
      ? settings.profTaxAmount
      : 0;
  return { pfEmployee, esicEmployee, profTax };
};

const calcMgmt = (earned, emp) => {
  const pfManagement = Math.round(earned.earnedBasic * 0.12);
  const esicManagement =
    emp.esicApplicable && earned.earnedGrossPay <= 21000
      ? Math.round(earned.earnedGrossPay * 0.0325)
      : null;
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

  const showToast = (msg, type = "success") => setToast({ message: msg, type });

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
          <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">
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
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
          <input
            type="password"
            placeholder="Confirm Password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
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
          <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">
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
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
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
    try {
      return JSON.parse(localStorage.getItem(KEYS.employees)) || [];
    } catch {
      return [];
    }
  });
  const [settings, setSettings] = useState(() => {
    try {
      return {
        ...defaultSettings,
        ...JSON.parse(localStorage.getItem(KEYS.settings)),
      };
    } catch {
      return defaultSettings;
    }
  });
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [slipEmp, setSlipEmp] = useState("");
  const [slipMonth, setSlipMonth] = useState(now.getMonth());
  const [slipYear, setSlipYear] = useState(now.getFullYear());

  const payrollKey = `${KEYS.payrollPrefix}${selectedYear}_${String(selectedMonth).padStart(2, "0")}`;
  const totalDays = getDaysInMonth(selectedMonth, selectedYear);
  const [payrollData, setPayrollData] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(payrollKey)) || {};
    } catch {
      return {};
    }
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
    try {
      setPayrollData(JSON.parse(localStorage.getItem(payrollKey)) || {});
    } catch {
      setPayrollData({});
    }
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

  const updatePayroll = (empId, field, value) => {
    setPayrollData((prev) => ({
      ...prev,
      [empId]: { ...currentPayroll[empId], [field]: parseFloat(value) || 0 },
    }));
  };

  const saveEmployee = (data) => {
    if (editingEmployee)
      setEmployees(
        employees.map((e) =>
          e.id === editingEmployee.id ? { ...data, id: editingEmployee.id } : e,
        ),
      );
    else setEmployees([...employees, { ...data, id: Date.now().toString() }]);
    setShowForm(false);
    setEditingEmployee(null);
  };

  const deleteEmployee = (id) => {
    if (confirm("Delete this employee?"))
      setEmployees(employees.filter((e) => e.id !== id));
  };

  const getCalc = (emp, entry, days) => {
    const presentDays = entry.presentDays || 0;
    const halfDays = entry.halfDays || 0;
    const paidLeave = entry.paidLeave || 0;
    const lopDays = entry.lopDays || 0;
    const paidDays = presentDays + halfDays * 0.5 + paidLeave;
    const components = calcComponents(emp.payScale);
    const earned = calcEarned(components, paidDays, days);
    const deductions = calcDeductions(earned, emp, settings);
    const mgmt = calcMgmt(earned, emp);
    const totalDeductions =
      deductions.pfEmployee +
      (deductions.esicEmployee || 0) +
      deductions.profTax +
      (entry.incomeTax || 0);
    return {
      components,
      earned,
      deductions,
      mgmt,
      totalDeductions,
      netPay: earned.earnedGrossPay - totalDeductions,
      ctc:
        earned.earnedGrossPay + mgmt.pfManagement + (mgmt.esicManagement || 0),
      paidDays,
      lopDays,
      halfDays,
    };
  };

  const years = Array.from({ length: 11 }, (_, i) => 2020 + i);

  return (
    <div
      className="min-h-screen bg-gray-100"
      style={{ fontFamily: "Inter, system-ui, sans-serif" }}
    >
      <nav className="bg-[#1E3A5F] text-white p-4 shadow-lg">
        <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-xl font-semibold">HR Payroll System</h1>
          <div className="flex items-center gap-2 flex-wrap">
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
              className="ml-2 px-4 py-2 bg-red-500 hover:bg-red-600 rounded-lg text-sm font-medium transition"
            >
              Logout
            </button>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto p-4 md:p-6">
        {activeTab === "employees" && (
          <EmployeeSection
            employees={employees}
            showForm={showForm}
            setShowForm={setShowForm}
            editing={editingEmployee}
            setEditing={setEditingEmployee}
            save={saveEmployee}
            del={deleteEmployee}
          />
        )}
        {activeTab === "payroll" && (
          <PayrollSection
            employees={employees}
            month={selectedMonth}
            setMonth={setSelectedMonth}
            year={selectedYear}
            setYear={setSelectedYear}
            totalDays={totalDays}
            payroll={currentPayroll}
            update={updatePayroll}
            calc={getCalc}
            years={years}
          />
        )}
        {activeTab === "slip" && (
          <SlipSection
            employees={employees}
            emp={slipEmp}
            setEmp={setSlipEmp}
            month={slipMonth}
            setMonth={setSlipMonth}
            year={slipYear}
            setYear={setSlipYear}
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

function EmployeeSection({
  employees,
  showForm,
  setShowForm,
  editing,
  setEditing,
  save,
  del,
}) {
  const [form, setForm] = useState(defaultEmployee);
  useEffect(() => {
    setForm(editing || defaultEmployee);
  }, [editing]);

  return (
    <div>
      <div className="flex justify-between items-center mb-6 flex-wrap gap-2">
        <h2 className="text-2xl font-semibold text-gray-800">
          Employee Master
        </h2>
        <button
          onClick={() => {
            setShowForm(true);
            setEditing(null);
          }}
          className="bg-[#1E3A5F] text-white px-5 py-2 rounded-lg hover:bg-[#2d5a87] transition font-medium"
        >
          + Add Employee
        </button>
      </div>
      {showForm && (
        <div className="bg-white p-6 rounded-xl shadow-md mb-6 border border-gray-200">
          <h3 className="text-lg font-semibold mb-4 text-gray-700">
            {editing ? "Edit Employee" : "Add New Employee"}
          </h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save(form);
              setForm(defaultEmployee);
            }}
            className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4"
          >
            <input
              type="text"
              placeholder="Name *"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Employee Code *"
              required
              value={form.empCode}
              onChange={(e) => setForm({ ...form, empCode: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="email"
              placeholder="Email Address"
              value={form.email || ""}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Designation"
              value={form.designation}
              onChange={(e) =>
                setForm({ ...form, designation: e.target.value })
              }
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Department"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="UAN No."
              value={form.uanNo}
              onChange={(e) => setForm({ ...form, uanNo: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="ESIC No."
              value={form.esicNo}
              onChange={(e) => setForm({ ...form, esicNo: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Bank Name"
              value={form.bankName}
              onChange={(e) => setForm({ ...form, bankName: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Account No."
              value={form.accountNo}
              onChange={(e) => setForm({ ...form, accountNo: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="IFSC Code"
              value={form.ifscCode}
              onChange={(e) => setForm({ ...form, ifscCode: e.target.value })}
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="date"
              value={form.dateOfJoining}
              onChange={(e) =>
                setForm({ ...form, dateOfJoining: e.target.value })
              }
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <input
              type="number"
              placeholder="Pay Scale (₹) *"
              required
              value={form.payScale || ""}
              onChange={(e) =>
                setForm({ ...form, payScale: parseFloat(e.target.value) || 0 })
              }
              className="border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <label className="flex items-center gap-3 p-3">
              <input
                type="checkbox"
                checked={form.esicApplicable}
                onChange={(e) =>
                  setForm({ ...form, esicApplicable: e.target.checked })
                }
                className="w-5 h-5 rounded"
              />
              <span className="text-gray-700">ESIC Applicable</span>
            </label>
            <div className="md:col-span-3 lg:col-span-4 flex gap-3 pt-2">
              <button
                type="submit"
                className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 font-medium transition"
              >
                {editing ? "Update" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditing(null);
                }}
                className="bg-gray-500 text-white px-6 py-2 rounded-lg hover:bg-gray-600 font-medium transition"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      <div className="bg-white rounded-xl shadow-md overflow-x-auto border border-gray-200">
        <table className="w-full">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">
                Code
              </th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">
                Name
              </th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">
                Email
              </th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">
                Designation
              </th>
              <th className="px-4 py-3 text-right text-sm font-semibold text-gray-600">
                Pay Scale
              </th>
              <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600">
                ESIC
              </th>
              <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 ? (
              <tr>
                <td
                  colSpan="7"
                  className="px-4 py-12 text-center text-gray-400"
                >
                  No employees added yet
                </td>
              </tr>
            ) : (
              employees.map((emp, i) => (
                <tr
                  key={emp.id}
                  className={`border-t hover:bg-blue-50 transition ${i % 2 === 0 ? "bg-white" : "bg-gray-50"}`}
                >
                  <td className="px-4 py-3 text-sm font-medium text-gray-800">
                    {emp.empCode}
                  </td>
                  <td className="px-4 py-3 text-sm">{emp.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {emp.email || "–"}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {emp.designation || "–"}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium">
                    {formatINR(emp.payScale)}
                  </td>
                  <td className="px-4 py-3 text-sm text-center">
                    {emp.esicApplicable ? (
                      <span className="text-green-600">Yes</span>
                    ) : (
                      <span className="text-gray-400">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-center">
                    <button
                      onClick={() => {
                        setEditing(emp);
                        setShowForm(true);
                      }}
                      className="text-blue-600 hover:underline mr-3"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => del(emp.id)}
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
  month,
  setMonth,
  year,
  setYear,
  totalDays,
  payroll,
  update,
  calc,
  years,
}) {
  const savedMonths = useMemo(() => {
    const months = [];
    for (let y = 2020; y <= 2030; y++) {
      for (let m = 0; m < 12; m++) {
        const key = `${KEYS.payrollPrefix}${y}_${String(m).padStart(2, "0")}`;
        const data = localStorage.getItem(key);
        if (data && data !== "{}") {
          try {
            const parsed = JSON.parse(data);
            if (Object.keys(parsed).length > 0) {
              months.push({
                year: y,
                month: m,
                label: `${monthNames[m]} ${y}`,
              });
            }
          } catch {}
        }
      }
    }
    return months;
  }, [month, year]);

  const hasData = Object.keys(payroll).some((id) => {
    const p = payroll[id];
    return (
      p &&
      (p.lopDays > 0 ||
        p.halfDays > 0 ||
        p.incomeTax > 0 ||
        p.presentDays !== totalDays)
    );
  });

  return (
    <div>
      <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-gray-800">
            Monthly Payroll
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Select month and enter attendance. Data is auto-saved.
          </p>
        </div>
        <div className="flex gap-3 items-center flex-wrap">
          <select
            value={month}
            onChange={(e) => setMonth(parseInt(e.target.value))}
            className="border border-gray-300 p-2 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            {monthNames.map((m, i) => (
              <option key={i} value={i}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value))}
            className="border border-gray-300 p-2 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <span className="text-gray-600 text-sm">
            Days: <strong>{totalDays}</strong>
          </span>
          {hasData && (
            <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-medium">
              ✓ Saved
            </span>
          )}
        </div>
      </div>

      {savedMonths.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
          <p className="text-sm text-blue-800 font-medium mb-2">
            📅 Saved Payroll Months:
          </p>
          <div className="flex flex-wrap gap-2">
            {savedMonths.map((s, i) => (
              <button
                key={i}
                onClick={() => {
                  setMonth(s.month);
                  setYear(s.year);
                }}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                  s.month === month && s.year === year
                    ? "bg-blue-600 text-white"
                    : "bg-white text-blue-700 border border-blue-300 hover:bg-blue-100"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="bg-white rounded-xl shadow-md overflow-x-auto border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-3 py-3 text-left font-semibold text-gray-600">
                Employee
              </th>
              <th className="px-2 py-3 text-center font-semibold text-gray-600">
                Present
              </th>
              <th className="px-2 py-3 text-center font-semibold text-gray-600">
                Half
              </th>
              <th className="px-2 py-3 text-center font-semibold text-gray-600">
                Paid Leave
              </th>
              <th className="px-2 py-3 text-center font-semibold text-gray-600">
                LOP
              </th>
              <th className="px-2 py-3 text-center font-semibold text-gray-600">
                Paid Days
              </th>
              <th className="px-2 py-3 text-right font-semibold text-gray-600">
                IT (₹)
              </th>
              <th className="px-2 py-3 text-right font-semibold text-gray-600">
                Earned
              </th>
              <th className="px-2 py-3 text-right font-semibold text-gray-600">
                PF
              </th>
              <th className="px-2 py-3 text-right font-semibold text-gray-600">
                ESIC
              </th>
              <th className="px-2 py-3 text-right font-semibold text-gray-600">
                PT
              </th>
              <th className="px-2 py-3 text-right font-semibold text-gray-600 text-green-700">
                Net Pay
              </th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 ? (
              <tr>
                <td
                  colSpan="12"
                  className="px-4 py-12 text-center text-gray-400"
                >
                  No employees. Add employees first.
                </td>
              </tr>
            ) : (
              employees.map((emp, i) => {
                const entry = payroll[emp.id] || {
                  ...defaultAttendance,
                  presentDays: totalDays,
                };
                const c = calc(emp, entry, totalDays);
                const totalEntered =
                  (entry.presentDays || 0) +
                  (entry.halfDays || 0) +
                  (entry.lopDays || 0);
                const isInvalid =
                  totalEntered > totalDays || entry.presentDays > totalDays;
                return (
                  <tr
                    key={emp.id}
                    className={`border-t hover:bg-blue-50 transition ${i % 2 === 0 ? "bg-white" : "bg-gray-50"} ${isInvalid ? "bg-red-50" : ""}`}
                  >
                    <td className="px-3 py-3 font-medium">
                      {emp.name}
                      <br />
                      <span className="text-xs text-gray-500">
                        {emp.empCode}
                      </span>
                      {isInvalid && (
                        <span className="block text-xs text-red-600 mt-1">
                          ⚠ Days exceed {totalDays}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-center">
                      <input
                        type="number"
                        min="0"
                        max={totalDays}
                        value={entry.presentDays}
                        onChange={(e) => {
                          const val = Math.min(
                            parseFloat(e.target.value) || 0,
                            totalDays,
                          );
                          update(emp.id, "presentDays", val);
                        }}
                        className={`w-14 border p-1 rounded text-center ${entry.presentDays > totalDays ? "border-red-500 bg-red-50" : ""}`}
                      />
                    </td>
                    <td className="px-2 py-3 text-center">
                      <input
                        type="number"
                        min="0"
                        max={totalDays}
                        value={entry.halfDays}
                        onChange={(e) => {
                          const val = Math.min(
                            parseFloat(e.target.value) || 0,
                            totalDays,
                          );
                          update(emp.id, "halfDays", val);
                        }}
                        className="w-14 border p-1 rounded text-center"
                      />
                    </td>
                    <td className="px-2 py-3 text-center">
                      <input
                        type="number"
                        min="0"
                        max={totalDays}
                        value={entry.paidLeave}
                        onChange={(e) => {
                          const val = Math.min(
                            parseFloat(e.target.value) || 0,
                            totalDays,
                          );
                          update(emp.id, "paidLeave", val);
                        }}
                        className="w-14 border p-1 rounded text-center"
                      />
                    </td>
                    <td className="px-2 py-3 text-center">
                      <input
                        type="number"
                        min="0"
                        max={totalDays}
                        value={entry.lopDays}
                        onChange={(e) => {
                          const val = Math.min(
                            parseFloat(e.target.value) || 0,
                            totalDays,
                          );
                          update(emp.id, "lopDays", val);
                        }}
                        className="w-14 border p-1 rounded text-center"
                      />
                    </td>
                    <td className="px-2 py-3 text-center font-medium">
                      {c.paidDays}
                    </td>
                    <td className="px-2 py-3 text-right">
                      <input
                        type="number"
                        min="0"
                        value={entry.incomeTax || ""}
                        onChange={(e) =>
                          update(emp.id, "incomeTax", e.target.value)
                        }
                        className="w-16 border p-1 rounded text-right"
                        placeholder="0"
                      />
                    </td>
                    <td className="px-2 py-3 text-right">
                      {formatINR(c.earned.earnedGrossPay)}
                    </td>
                    <td className="px-2 py-3 text-right">
                      {formatINR(c.deductions.pfEmployee)}
                    </td>
                    <td className="px-2 py-3 text-right">
                      {c.deductions.esicEmployee !== null
                        ? formatINR(c.deductions.esicEmployee)
                        : "–"}
                    </td>
                    <td className="px-2 py-3 text-right">
                      {formatINR(c.deductions.profTax)}
                    </td>
                    <td className="px-2 py-3 text-right font-semibold text-green-700">
                      {formatINR(c.netPay)}
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
  emp,
  setEmp,
  month,
  setMonth,
  year,
  setYear,
  settings,
  years,
  showToast,
  payrollKey,
}) {
  const slipRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const totalDays = getDaysInMonth(month, year);
  const employee = employees.find((e) => e.id === emp);
  const [payrollData, setPayrollData] = useState({});

  const savedMonths = useMemo(() => {
    const months = [];
    for (let y = 2020; y <= 2030; y++) {
      for (let m = 0; m < 12; m++) {
        const key = `${KEYS.payrollPrefix}${y}_${String(m).padStart(2, "0")}`;
        const data = localStorage.getItem(key);
        if (data && data !== "{}") {
          try {
            const parsed = JSON.parse(data);
            if (Object.keys(parsed).length > 0) {
              months.push({
                year: y,
                month: m,
                label: `${monthNames[m]} ${y}`,
              });
            }
          } catch {}
        }
      }
    }
    return months;
  }, [month, year]);

  useEffect(() => {
    try {
      setPayrollData(JSON.parse(localStorage.getItem(payrollKey)) || {});
    } catch {
      setPayrollData({});
    }
  }, [payrollKey]);

  const entry = payrollData[emp] || {
    ...defaultAttendance,
    presentDays: totalDays,
  };
  const presentDays = entry.presentDays || 0;
  const halfDays = entry.halfDays || 0;
  const paidLeave = entry.paidLeave || 0;
  const lopDays = entry.lopDays || 0;
  const paidDays = presentDays + halfDays * 0.5 + paidLeave;

  let slipData = null;
  if (employee) {
    const components = calcComponents(employee.payScale);
    const earned = calcEarned(components, paidDays, totalDays);
    const deductions = calcDeductions(earned, employee, settings);
    const mgmt = calcMgmt(earned, employee);
    const totalDeductions =
      deductions.pfEmployee +
      (deductions.esicEmployee || 0) +
      deductions.profTax +
      (entry.incomeTax || 0);
    slipData = {
      components,
      earned,
      deductions,
      mgmt,
      totalDeductions,
      netPay: earned.earnedGrossPay - totalDeductions,
      ctc:
        earned.earnedGrossPay + mgmt.pfManagement + (mgmt.esicManagement || 0),
      entry,
      paidDays,
      lopDays,
      halfDays,
    };
  }

  const downloadPDF = async () => {
    if (!slipRef.current || !employee) return;
    setLoading(true);
    try {
      await new Promise((r) => setTimeout(r, 100));
      const canvas = await window.html2canvas(slipRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new window.jspdf.jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
      });
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
      pdf.save(
        `${employee.empCode}_${employee.name.replace(/\s+/g, "_")}_${monthNames[month]}${year}_Salary_Slip.pdf`,
      );
      showToast("PDF downloaded successfully");
    } catch (err) {
      showToast("Failed to generate PDF: " + err.message, "error");
    }
    setLoading(false);
  };

  const sendEmail = async () => {
    if (!employee || !employee.email) {
      showToast("Employee email not configured", "error");
      return;
    }
    if (
      !settings.emailServiceId ||
      !settings.emailTemplateId ||
      !settings.emailPublicKey
    ) {
      showToast("Configure email in Settings first", "error");
      return;
    }
    setEmailLoading(true);
    try {
      await new Promise((r) => setTimeout(r, 100));
      const canvas = await window.html2canvas(slipRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
      });
      const imgData = canvas.toDataURL("image/png");
      await window.emailjs.send(
        settings.emailServiceId,
        settings.emailTemplateId,
        {
          to_email: employee.email,
          to_name: employee.name,
          month_year: `${monthNames[month]} ${year}`,
          company_name: settings.companyName,
          net_pay: formatINR(slipData.netPay),
          slip_image: imgData,
        },
        settings.emailPublicKey,
      );
      showToast(`Slip sent to ${employee.email}`);
    } catch (err) {
      showToast("Failed to send email: " + (err.text || err.message), "error");
    }
    setEmailLoading(false);
  };

  const emailConfigured =
    settings.emailServiceId &&
    settings.emailTemplateId &&
    settings.emailPublicKey;

  const hasPayrollData = Object.keys(payrollData).length > 0;

  return (
    <div>
      <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-gray-800">Salary Slip</h2>
          <p className="text-sm text-gray-500 mt-1">
            Select employee and month to generate slip
          </p>
        </div>
        <div className="flex gap-3 items-center flex-wrap">
          <select
            value={emp}
            onChange={(e) => setEmp(e.target.value)}
            className="border border-gray-300 p-2 rounded-lg min-w-48 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            <option value="">Select Employee</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.empCode})
              </option>
            ))}
          </select>
          <select
            value={month}
            onChange={(e) => setMonth(parseInt(e.target.value))}
            className="border border-gray-300 p-2 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            {monthNames.map((m, i) => (
              <option key={i} value={i}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value))}
            className="border border-gray-300 p-2 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          {hasPayrollData ? (
            <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-medium">
              ✓ Payroll Data
            </span>
          ) : (
            <span className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full text-xs font-medium">
              No Payroll Data
            </span>
          )}
          {employee && (
            <>
              <button
                onClick={downloadPDF}
                disabled={loading}
                className="bg-[#1E3A5F] text-white px-4 py-2 rounded-lg hover:bg-[#2d5a87] transition font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {loading && <span className="animate-spin">⏳</span>} Download
                PDF
              </button>
              <button
                onClick={sendEmail}
                disabled={emailLoading || !emailConfigured}
                title={
                  !emailConfigured ? "Configure email in Settings first" : ""
                }
                className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {emailLoading && <span className="animate-spin">⏳</span>} Email
                Slip
              </button>
            </>
          )}
        </div>
      </div>

      {savedMonths.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
          <p className="text-sm text-green-800 font-medium mb-2">
            📅 Months with Saved Payroll (click to select):
          </p>
          <div className="flex flex-wrap gap-2">
            {savedMonths.map((s, i) => (
              <button
                key={i}
                onClick={() => {
                  setMonth(s.month);
                  setYear(s.year);
                }}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                  s.month === month && s.year === year
                    ? "bg-green-600 text-white"
                    : "bg-white text-green-700 border border-green-300 hover:bg-green-100"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!employee ? (
        <div className="bg-white rounded-xl shadow-md p-12 text-center text-gray-400 border border-gray-200">
          Select an employee to preview salary slip
        </div>
      ) : (
        <div className="overflow-auto">
          <div
            ref={slipRef}
            className="bg-white shadow-lg mx-auto"
            style={{ width: "794px", padding: "40px", minHeight: "1123px" }}
          >
            <div className="text-center mb-6 border-b-2 border-gray-300 pb-4">
              {settings.companyLogo && (
                <img
                  src={settings.companyLogo}
                  alt="Logo"
                  className="h-16 mx-auto mb-2"
                />
              )}
              <h2 className="text-2xl font-bold text-gray-800">
                {settings.companyName}
              </h2>
              <p className="text-lg font-semibold text-[#1E3A5F] mt-1">
                Salary Slip – {monthNames[month]} {year}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-x-8 gap-y-2 mb-6 text-sm border-b border-gray-200 pb-4">
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
            </div>

            <div className="bg-gray-100 p-3 rounded mb-4 text-sm">
              <span className="font-semibold">Attendance:</span> Total Days:{" "}
              {totalDays} | Present: {entry.presentDays} | Half Days:{" "}
              {entry.halfDays} | Paid Leave: {entry.paidLeave} | LOP:{" "}
              {entry.lopDays} |{" "}
              <span className="font-semibold">
                Paid Days: {slipData.paidDays}
              </span>
            </div>

            <div className="mb-4">
              <h3 className="font-bold text-gray-700 mb-2 bg-[#1E3A5F] text-white px-3 py-2 text-sm">
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
                  {[
                    [
                      "Basic Salary",
                      slipData.components.basic,
                      slipData.earned.earnedBasic,
                    ],
                    ["HRA", slipData.components.hra, slipData.earned.earnedHRA],
                    [
                      "Conveyance",
                      slipData.components.conveyance,
                      slipData.earned.earnedConveyance,
                    ],
                    [
                      "Medical Allowance",
                      slipData.components.medical,
                      slipData.earned.earnedMedical,
                    ],
                    [
                      "Special Allowance",
                      slipData.components.special,
                      slipData.earned.earnedSpecial,
                    ],
                    [
                      "Bonus (8.33%)",
                      slipData.components.bonus,
                      slipData.earned.earnedBonus,
                    ],
                  ].map(([name, actual, earned], i) => (
                    <tr
                      key={name}
                      className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}
                    >
                      <td className="py-2 px-3">{name}</td>
                      <td className="text-right py-2 px-3">
                        {formatINR(actual)}
                      </td>
                      <td className="text-right py-2 px-3">
                        {formatINR(earned)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-gray-100 font-semibold">
                    <td className="py-2 px-3">GROSS PAY PF</td>
                    <td className="text-right py-2 px-3">
                      {formatINR(slipData.components.grossPayPF)}
                    </td>
                    <td className="text-right py-2 px-3">
                      {formatINR(slipData.earned.earnedGrossPayPF)}
                    </td>
                  </tr>
                  <tr className="bg-[#e8f4fc] font-bold">
                    <td className="py-2 px-3">GROSS PAY</td>
                    <td className="text-right py-2 px-3">
                      {formatINR(slipData.components.grossPay)}
                    </td>
                    <td className="text-right py-2 px-3">
                      {formatINR(slipData.earned.earnedGrossPay)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mb-4">
              <h3 className="font-bold text-gray-700 mb-2 bg-[#1E3A5F] text-white px-3 py-2 text-sm">
                DEDUCTIONS
              </h3>
              <table className="w-full text-sm">
                <tbody>
                  <tr className="bg-white">
                    <td className="py-2 px-3">P.F. Employee (12%)</td>
                    <td className="text-right py-2 px-3">
                      {formatINR(slipData.deductions.pfEmployee)}
                    </td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="py-2 px-3">ESIC Employee (0.75%)</td>
                    <td className="text-right py-2 px-3">
                      {slipData.deductions.esicEmployee !== null
                        ? formatINR(slipData.deductions.esicEmployee)
                        : "–"}
                    </td>
                  </tr>
                  <tr className="bg-white">
                    <td className="py-2 px-3">Professional Tax</td>
                    <td className="text-right py-2 px-3">
                      {formatINR(slipData.deductions.profTax)}
                    </td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="py-2 px-3">Income Tax</td>
                    <td className="text-right py-2 px-3">
                      {formatINR(slipData.entry.incomeTax || 0)}
                    </td>
                  </tr>
                  <tr className="bg-red-50 font-bold">
                    <td className="py-2 px-3">Total Deductions</td>
                    <td className="text-right py-2 px-3 text-red-600">
                      {formatINR(slipData.totalDeductions)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-[#2ECC71] text-white p-4 rounded mb-4">
              <div className="flex justify-between items-center text-lg">
                <span className="font-bold">NET PAY</span>
                <span className="font-bold text-2xl">
                  {formatINR(slipData.netPay)}
                </span>
              </div>
              <div className="flex justify-between items-center mt-1 text-sm opacity-90">
                <span>CTC (Cost to Company)</span>
                <span className="font-semibold">{formatINR(slipData.ctc)}</span>
              </div>
            </div>

            <div className="mb-6">
              <h3 className="font-bold text-gray-700 mb-2 bg-gray-200 px-3 py-2 text-sm">
                MANAGEMENT CONTRIBUTIONS
              </h3>
              <table className="w-full text-sm">
                <tbody>
                  <tr className="bg-white">
                    <td className="py-2 px-3">P.F. Management (12%)</td>
                    <td className="text-right py-2 px-3">
                      {formatINR(slipData.mgmt.pfManagement)}
                    </td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="py-2 px-3">ESIC Management (3.25%)</td>
                    <td className="text-right py-2 px-3">
                      {slipData.mgmt.esicManagement !== null
                        ? formatINR(slipData.mgmt.esicManagement)
                        : "–"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="border-t-2 border-gray-300 pt-6 mt-8">
              <div className="flex justify-between items-end">
                <div className="text-sm text-gray-500">
                  <p>For {settings.companyName}</p>
                </div>
                <div className="text-right">
                  <div className="flex justify-end gap-8 mb-2">
                    {settings.signatureImage && (
                      <img
                        src={settings.signatureImage}
                        alt="Signature"
                        style={{ maxHeight: "60px" }}
                      />
                    )}
                    {settings.sealImage && (
                      <img
                        src={settings.sealImage}
                        alt="Seal"
                        style={{ maxHeight: "60px" }}
                      />
                    )}
                  </div>
                  <div className="border-t border-gray-400 w-48 mb-1 ml-auto"></div>
                  <p className="font-semibold text-gray-800">
                    {settings.signatoryName || "Authorized Signatory"}
                  </p>
                  <p className="text-gray-500 text-sm">
                    {settings.signatoryDesignation}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsSection({ settings, setSettings }) {
  const handleFile = (field) => (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () =>
        setSettings({ ...settings, [field]: reader.result });
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-2xl font-semibold text-gray-800 mb-6">Settings</h2>
      <div className="bg-white rounded-xl shadow-md p-6 space-y-6 border border-gray-200">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Company Logo
            </label>
            <input
              type="file"
              accept="image/*"
              onChange={handleFile("companyLogo")}
              className="w-full border border-gray-300 p-2 rounded-lg text-sm"
            />
            {settings.companyLogo && (
              <div className="mt-2 flex items-center gap-3">
                <img
                  src={settings.companyLogo}
                  alt="Logo"
                  className="h-12 border rounded"
                />
                <button
                  onClick={() => setSettings({ ...settings, companyLogo: "" })}
                  className="text-red-600 text-sm hover:underline"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="border-t pt-6">
          <h3 className="font-semibold text-gray-700 mb-4">
            Authorized Signatory
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Signatory Name
              </label>
              <input
                type="text"
                value={settings.signatoryName}
                onChange={(e) =>
                  setSettings({ ...settings, signatoryName: e.target.value })
                }
                className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="e.g. John Smith"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Designation
              </label>
              <input
                type="text"
                value={settings.signatoryDesignation}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    signatoryDesignation: e.target.value,
                  })
                }
                className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Signature Image
              </label>
              <input
                type="file"
                accept="image/*"
                onChange={handleFile("signatureImage")}
                className="w-full border border-gray-300 p-2 rounded-lg text-sm"
              />
              {settings.signatureImage && (
                <div className="mt-2 flex items-center gap-3">
                  <img
                    src={settings.signatureImage}
                    alt="Signature"
                    className="h-12 border rounded"
                  />
                  <button
                    onClick={() =>
                      setSettings({ ...settings, signatureImage: "" })
                    }
                    className="text-red-600 text-sm hover:underline"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Company Seal (Optional)
              </label>
              <input
                type="file"
                accept="image/*"
                onChange={handleFile("sealImage")}
                className="w-full border border-gray-300 p-2 rounded-lg text-sm"
              />
              {settings.sealImage && (
                <div className="mt-2 flex items-center gap-3">
                  <img
                    src={settings.sealImage}
                    alt="Seal"
                    className="h-12 border rounded"
                  />
                  <button
                    onClick={() => setSettings({ ...settings, sealImage: "" })}
                    className="text-red-600 text-sm hover:underline"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t pt-6">
          <h3 className="font-semibold text-gray-700 mb-4">
            PF & Tax Settings
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="flex items-center gap-3 p-3 border rounded-lg">
              <input
                type="checkbox"
                checked={settings.pfCeiling}
                onChange={(e) =>
                  setSettings({ ...settings, pfCeiling: e.target.checked })
                }
                className="w-5 h-5 rounded"
              />
              <span className="text-sm">Apply ₹15,000 PF ceiling</span>
            </label>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Prof Tax Threshold (₹)
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
                className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Prof Tax Amount (₹)
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
                className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        <div className="border-t pt-6">
          <h3 className="font-semibold text-gray-700 mb-4">
            Email Configuration (EmailJS)
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            Configure EmailJS to send salary slips via email.{" "}
            <a
              href="https://www.emailjs.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Get your free EmailJS account →
            </a>
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Service ID
              </label>
              <input
                type="text"
                value={settings.emailServiceId}
                onChange={(e) =>
                  setSettings({ ...settings, emailServiceId: e.target.value })
                }
                className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="service_xxxxx"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Template ID
              </label>
              <input
                type="text"
                value={settings.emailTemplateId}
                onChange={(e) =>
                  setSettings({ ...settings, emailTemplateId: e.target.value })
                }
                className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="template_xxxxx"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Public Key
              </label>
              <input
                type="text"
                value={settings.emailPublicKey}
                onChange={(e) =>
                  setSettings({ ...settings, emailPublicKey: e.target.value })
                }
                className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="Your public key"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Sender Name
              </label>
              <input
                type="text"
                value={settings.emailSenderName}
                onChange={(e) =>
                  setSettings({ ...settings, emailSenderName: e.target.value })
                }
                className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="HR - Company Name"
              />
            </div>
          </div>
        </div>

        <div className="border-t pt-4 text-sm text-gray-500">
          All settings are automatically saved to localStorage.
        </div>
      </div>
    </div>
  );
}
