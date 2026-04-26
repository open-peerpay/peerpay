import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  App as AntApp,
  Button,
  ConfigProvider,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { MenuProps, TableProps } from "antd";
import {
  ApiOutlined,
  AppstoreOutlined,
  BellOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudSyncOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FileSearchOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
  WalletOutlined
} from "@ant-design/icons";
import type {
  Account,
  AmountOccupation,
  CallbackLog,
  Device,
  NotificationLog,
  Order,
  OrderStatus,
  PresetQrCode,
  SystemLog
} from "../shared/types";
import {
  createAccount,
  createOrder,
  deleteQrCode,
  getAdminSession,
  loadSnapshot,
  loginAdmin,
  logoutAdmin,
  retryCallback,
  setAccountEnabled,
  setDeviceEnabled,
  setupAdmin,
  updateAccountSettings,
  updateOrderStatus,
  upsertQrCodes,
  type AdminSessionState,
  type Snapshot
} from "./api";

type ViewKey = "dashboard" | "orders" | "accounts" | "payments" | "logs" | "callbacks";
type Columns<T> = NonNullable<TableProps<T>["columns"]>;

const { Header, Sider, Content } = Layout;
const { Text, Title } = Typography;
const { TextArea } = Input;

const emptySnapshot: Snapshot = {
  dashboard: {
    orders: { total: 0, pending: 0, paid: 0, notified: 0, expired: 0, paidToday: 0, successRate: 0 },
    devices: { total: 0, online: 0 },
    amountPool: { occupied: 0, presetQrCodes: 0, fallbackAccounts: 0 },
    callbacks: { pending: 0, failed: 0 }
  },
  accounts: [],
  orders: { items: [], total: 0, limit: 80, offset: 0 },
  occupations: { items: [], total: 0, limit: 160, offset: 0 },
  qrCodes: { items: [], total: 0, limit: 160, offset: 0 },
  devices: [],
  notifications: { items: [], total: 0, limit: 80, offset: 0 },
  systemLogs: { items: [], total: 0, limit: 80, offset: 0 },
  callbacks: { items: [], total: 0, limit: 80, offset: 0 }
};

const menuItems: MenuProps["items"] = [
  { key: "dashboard", icon: <AppstoreOutlined />, label: "仪表盘" },
  { key: "orders", icon: <WalletOutlined />, label: "订单管理" },
  { key: "accounts", icon: <ApiOutlined />, label: "账户设备" },
  { key: "payments", icon: <DatabaseOutlined />, label: "收款码" },
  { key: "logs", icon: <FileSearchOutlined />, label: "日志中心" },
  { key: "callbacks", icon: <CloudSyncOutlined />, label: "回调管理" }
];

const viewTitles: Record<ViewKey, string> = {
  dashboard: "仪表盘",
  orders: "订单管理",
  accounts: "账户设备",
  payments: "收款码",
  logs: "日志中心",
  callbacks: "回调管理"
};

const statusColor: Record<string, string> = {
  pending: "processing",
  paid: "success",
  notified: "default",
  expired: "error",
  preset: "success",
  fallback: "warning",
  matched: "success",
  unmatched: "warning",
  parse_failed: "error",
  success: "success",
  failed: "error",
  info: "blue",
  warn: "gold",
  error: "red"
};

const statusText: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  notified: "已通知",
  expired: "已过期",
  preset: "定额码",
  fallback: "通用码",
  matched: "已匹配",
  unmatched: "未匹配",
  parse_failed: "解析失败",
  success: "成功",
  failed: "失败",
  info: "信息",
  warn: "警告",
  error: "异常"
};

function StatusTag({ value }: { value: string }) {
  return <Tag color={statusColor[value] ?? "default"}>{statusText[value] ?? value}</Tag>;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "-";
}

function metricClass(value: "blue" | "green" | "amber" | "red") {
  return `metric metric-${value}`;
}

function normalizeQrLines(lines: string) {
  return lines
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [amount, ...urlParts] = line.split(/\s+/);
      return { amount, payUrl: urlParts.join(" ") };
    });
}

interface GateProps {
  mode: "setup" | "login";
  onDone: (state: AdminSessionState) => void;
}

function AdminGate({ mode, onDone }: GateProps) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);

  const handleFinish = useCallback(async (values: { password: string }) => {
    setSaving(true);
    try {
      const state = mode === "setup" ? await setupAdmin(values.password) : await loginAdmin(values.password);
      message.success(mode === "setup" ? "初始化完成" : "登录成功");
      onDone(state);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setSaving(false);
    }
  }, [message, mode, onDone]);

  return (
    <div className="auth-page">
      <div className="auth-panel">
        <div className="brand auth-brand">
          <div className="brand-mark">P</div>
          <div>
            <div className="brand-title">PeerPay</div>
            <Text type="secondary">{mode === "setup" ? "初始化管理后台" : "管理后台登录"}</Text>
          </div>
        </div>
        <Form form={form} layout="vertical" onFinish={handleFinish}>
          <Form.Item name="password" label="管理密码" rules={[{ required: true, min: 8, message: "请输入至少 8 位密码" }]}>
            <Input.Password prefix={<LockOutlined />} autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saving}>
            {mode === "setup" ? "完成初始化" : "登录"}
          </Button>
        </Form>
      </div>
    </div>
  );
}

export function AdminApp() {
  const [session, setSession] = useState<AdminSessionState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAdminSession()
      .then(setSession)
      .finally(() => setLoading(false));
  }, []);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#2563eb",
          colorSuccess: "#16803c",
          colorWarning: "#b7791f",
          colorError: "#c2410c",
          borderRadius: 6,
          fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        },
        components: {
          Layout: { bodyBg: "#f6f8fb", siderBg: "#ffffff", headerBg: "#ffffff" },
          Table: { headerBg: "#f7f9fc", rowHoverBg: "#f4f8ff" }
        }
      }}
    >
      <AntApp>
        {loading ? <div className="auth-page" /> : session?.setupRequired ? (
          <AdminGate mode="setup" onDone={setSession} />
        ) : session?.authenticated ? (
          <PeerPayShell onLoggedOut={() => setSession((current) => current ? { ...current, authenticated: false } : current)} />
        ) : (
          <AdminGate mode="login" onDone={setSession} />
        )}
      </AntApp>
    </ConfigProvider>
  );
}

interface ModalProps {
  accounts: Account[];
  open: boolean;
  onCancel: () => void;
  onRefresh: () => void;
}

function CreateOrderModal({ accounts, open, onCancel, onRefresh }: ModalProps) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const accountOptions = useMemo(() => accounts.map((account) => ({
    label: `${account.name} (${account.code})`,
    value: account.code
  })), [accounts]);

  const handleFinish = useCallback(async (values: Record<string, unknown>) => {
    setSaving(true);
    try {
      await createOrder(values as never);
      message.success("订单已创建");
      form.resetFields();
      onCancel();
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "订单创建失败");
    } finally {
      setSaving(false);
    }
  }, [form, message, onCancel, onRefresh]);

  return (
    <Modal title="创建订单" open={open} confirmLoading={saving} destroyOnHidden okText="创建" cancelText="取消" onOk={form.submit} onCancel={onCancel}>
      <Form form={form} layout="vertical" initialValues={{ ttlMinutes: 15 }} onFinish={handleFinish}>
        <Form.Item name="accountCode" label="账户" rules={[{ required: true, message: "请选择账户" }]}>
          <Select options={accountOptions} placeholder="选择账户" />
        </Form.Item>
        <Form.Item name="amount" label="订单金额" rules={[{ required: true, message: "请输入订单金额" }]}>
          <InputNumber min={0.01} precision={2} step={0.01} prefix="¥" className="full-width" />
        </Form.Item>
        <Form.Item name="merchantOrderId" label="商户订单号">
          <Input allowClear />
        </Form.Item>
        <Form.Item name="subject" label="标题">
          <Input allowClear />
        </Form.Item>
        <Form.Item name="callbackUrl" label="回调地址">
          <Input allowClear />
        </Form.Item>
        <Form.Item name="callbackSecret" label="回调密钥">
          <Input.Password />
        </Form.Item>
        <Form.Item name="ttlMinutes" label="有效分钟数" rules={[{ required: true, message: "请输入有效分钟数" }]}>
          <InputNumber min={1} max={1440} precision={0} className="full-width" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function QrCodeModal({ accounts, open, onCancel, onRefresh }: ModalProps) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const accountOptions = useMemo(() => accounts.map((account) => ({
    label: `${account.name} (${account.code})`,
    value: account.code
  })), [accounts]);

  const handleFinish = useCallback(async (values: { accountCode: string; lines: string }) => {
    const items = normalizeQrLines(values.lines);
    if (items.some((item) => !item.amount || !item.payUrl)) {
      message.error("二维码配置格式无效");
      return;
    }

    setSaving(true);
    try {
      const result = await upsertQrCodes({ accountCode: values.accountCode, items });
      message.success(`已保存 ${result.saved} 条二维码`);
      form.resetFields();
      onCancel();
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "二维码保存失败");
    } finally {
      setSaving(false);
    }
  }, [form, message, onCancel, onRefresh]);

  return (
    <Modal title="导入定额二维码" open={open} confirmLoading={saving} destroyOnHidden okText="保存" cancelText="取消" onOk={form.submit} onCancel={onCancel}>
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item name="accountCode" label="账户" rules={[{ required: true, message: "请选择账户" }]}>
          <Select options={accountOptions} placeholder="选择账户" />
        </Form.Item>
        <Form.Item name="lines" label="二维码" rules={[{ required: true, message: "请输入二维码配置" }]}>
          <TextArea rows={10} placeholder={"10.00 https://pay.example/10.00\n10.01 https://pay.example/10.01"} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function AccountModal({ open, onCancel, onRefresh }: Omit<ModalProps, "accounts">) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);

  const handleFinish = useCallback(async (values: Record<string, unknown>) => {
    setSaving(true);
    try {
      await createAccount(values as never);
      message.success("账户已创建");
      form.resetFields();
      onCancel();
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "账户创建失败");
    } finally {
      setSaving(false);
    }
  }, [form, message, onCancel, onRefresh]);

  return (
    <Modal title="创建账户" open={open} confirmLoading={saving} destroyOnHidden okText="创建" cancelText="取消" onOk={form.submit} onCancel={onCancel}>
      <Form form={form} layout="vertical" initialValues={{ maxOffsetCents: 99 }} onFinish={handleFinish}>
        <Form.Item name="code" label="编码" rules={[{ required: true, message: "请输入编码" }]}>
          <Input allowClear />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
          <Input allowClear />
        </Form.Item>
        <Form.Item name="maxOffsetCents" label="最大偏移分" rules={[{ required: true, message: "请输入最大偏移" }]}>
          <InputNumber min={0} max={9999} precision={0} className="full-width" />
        </Form.Item>
        <Form.Item name="fallbackPayUrl" label="兜底收款码 URL">
          <Input allowClear />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface AccountSettingsModalProps {
  account: Account | null;
  open: boolean;
  onCancel: () => void;
  onRefresh: () => void;
}

function AccountSettingsModal({ account, open, onCancel, onRefresh }: AccountSettingsModalProps) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account && open) {
      form.setFieldsValue({
        maxOffsetCents: account.maxOffsetCents,
        fallbackPayUrl: account.fallbackPayUrl
      });
    }
  }, [account, form, open]);

  const handleFinish = useCallback(async (values: { maxOffsetCents: number; fallbackPayUrl?: string }) => {
    if (!account) {
      return;
    }
    setSaving(true);
    try {
      await updateAccountSettings(account.id, {
        maxOffsetCents: values.maxOffsetCents,
        fallbackPayUrl: values.fallbackPayUrl || null
      });
      message.success("账户配置已更新");
      onCancel();
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "账户配置更新失败");
    } finally {
      setSaving(false);
    }
  }, [account, message, onCancel, onRefresh]);

  return (
    <Modal title="收款配置" open={open} confirmLoading={saving} destroyOnHidden okText="保存" cancelText="取消" onOk={form.submit} onCancel={onCancel}>
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item name="maxOffsetCents" label="最大偏移分" rules={[{ required: true, message: "请输入最大偏移" }]}>
          <InputNumber min={0} max={9999} precision={0} className="full-width" />
        </Form.Item>
        <Form.Item name="fallbackPayUrl" label="兜底收款码 URL">
          <Input allowClear />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function DashboardView({ snapshot }: { snapshot: Snapshot }) {
  const stats = snapshot.dashboard;
  return (
    <div className="view-stack">
      <section className="metrics-grid">
        <div className={metricClass("blue")}>
          <Statistic title="订单总数" value={stats.orders.total} prefix={<WalletOutlined />} />
          <Text type="secondary">待支付 {stats.orders.pending}</Text>
        </div>
        <div className={metricClass("green")}>
          <Statistic title="今日支付" value={stats.orders.paidToday} prefix={<CheckCircleOutlined />} />
          <Text type="secondary">成功率 {stats.orders.successRate}%</Text>
        </div>
        <div className={metricClass("amber")}>
          <Statistic title="金额占用" value={stats.amountPool.occupied} prefix={<ClockCircleOutlined />} />
          <Text type="secondary">定额码 {stats.amountPool.presetQrCodes}</Text>
        </div>
        <div className={metricClass("red")}>
          <Statistic title="在线设备" value={stats.devices.online} prefix={<BellOutlined />} />
          <Text type="secondary">兜底账户 {stats.amountPool.fallbackAccounts}</Text>
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <Title level={4}>最近订单</Title>
        </div>
        <Table<Order>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={snapshot.orders.items.slice(0, 8)}
          columns={[
            { title: "订单号", dataIndex: "id", ellipsis: true },
            { title: "账户", dataIndex: "accountCode", width: 110 },
            { title: "实付金额", dataIndex: "actualAmount", width: 110 },
            { title: "付款", dataIndex: "payMode", width: 110, render: (value) => <StatusTag value={String(value)} /> },
            { title: "状态", dataIndex: "status", width: 110, render: (value) => <StatusTag value={String(value)} /> },
            { title: "创建时间", dataIndex: "createdAt", width: 190, render: formatDate }
          ]}
        />
      </section>
    </div>
  );
}

function PeerPayShell({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { message } = AntApp.useApp();
  const [activeView, setActiveView] = useState<ViewKey>("dashboard");
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [orderOpen, setOrderOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsAccount, setSettingsAccount] = useState<Account | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadSnapshot();
      startTransition(() => setSnapshot(next));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const handleLogout = useCallback(async () => {
    await logoutAdmin();
    onLoggedOut();
  }, [onLoggedOut]);

  const handleSetOrderStatus = useCallback(async (id: string, status: OrderStatus) => {
    try {
      await updateOrderStatus(id, status);
      message.success("订单已更新");
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "订单更新失败");
    }
  }, [message, refresh]);

  const handleDeleteQr = useCallback(async (id: number) => {
    try {
      await deleteQrCode(id);
      message.success("二维码已删除");
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "二维码删除失败");
    }
  }, [message, refresh]);

  const handleRetryCallback = useCallback(async (id: number) => {
    try {
      await retryCallback(id);
      message.success("回调已重发");
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "回调重发失败");
    }
  }, [message, refresh]);

  const handleAccountToggle = useCallback(async (id: number, enabled: boolean) => {
    try {
      await setAccountEnabled(id, enabled);
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "账户状态更新失败");
    }
  }, [message, refresh]);

  const handleDeviceToggle = useCallback(async (id: number, enabled: boolean) => {
    try {
      await setDeviceEnabled(id, enabled);
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "设备状态更新失败");
    }
  }, [message, refresh]);

  const orderColumns = useMemo<Columns<Order>>(() => [
    { title: "订单号", dataIndex: "id", width: 220, ellipsis: true },
    { title: "商户单号", dataIndex: "merchantOrderId", width: 160, ellipsis: true, render: (value) => value || "-" },
    { title: "账户", dataIndex: "accountCode", width: 110 },
    { title: "订单金额", dataIndex: "requestedAmount", width: 110 },
    { title: "实付金额", dataIndex: "actualAmount", width: 110 },
    { title: "付款", dataIndex: "payMode", width: 110, render: (value) => <StatusTag value={String(value)} /> },
    { title: "状态", dataIndex: "status", width: 110, render: (value) => <StatusTag value={String(value)} /> },
    { title: "付款 URL", dataIndex: "payUrl", ellipsis: true },
    { title: "过期时间", dataIndex: "expireAt", width: 190, render: formatDate },
    {
      title: "操作",
      key: "actions",
      width: 120,
      fixed: "right",
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="标记支付">
            <Button size="small" icon={<CheckCircleOutlined />} disabled={record.status !== "pending"} onClick={() => handleSetOrderStatus(record.id, "paid")} />
          </Tooltip>
          <Tooltip title="标记过期">
            <Button size="small" danger icon={<ClockCircleOutlined />} disabled={record.status !== "pending"} onClick={() => handleSetOrderStatus(record.id, "expired")} />
          </Tooltip>
        </Space>
      )
    }
  ], [handleSetOrderStatus]);

  const occupationColumns = useMemo<Columns<AmountOccupation>>(() => [
    { title: "订单号", dataIndex: "orderId", width: 220, ellipsis: true },
    { title: "账户", dataIndex: "accountCode", width: 110 },
    { title: "订单金额", dataIndex: "requestedAmount", width: 110 },
    { title: "占用金额", dataIndex: "actualAmount", width: 110 },
    { title: "付款", dataIndex: "payMode", width: 110, render: (value) => <StatusTag value={String(value)} /> },
    { title: "过期时间", dataIndex: "expireAt", width: 190, render: formatDate }
  ], []);

  const qrColumns = useMemo<Columns<PresetQrCode>>(() => [
    { title: "账户", dataIndex: "accountCode", width: 110 },
    { title: "金额", dataIndex: "amount", width: 110 },
    { title: "付款 URL", dataIndex: "payUrl", ellipsis: true },
    { title: "更新时间", dataIndex: "updatedAt", width: 190, render: formatDate },
    {
      title: "操作",
      key: "actions",
      width: 80,
      fixed: "right",
      render: (_, record) => (
        <Tooltip title="删除">
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteQr(record.id)} />
        </Tooltip>
      )
    }
  ], [handleDeleteQr]);

  const accountColumns = useMemo<Columns<Account>>(() => [
    { title: "编码", dataIndex: "code", width: 140 },
    { title: "名称", dataIndex: "name" },
    { title: "最大偏移", dataIndex: "maxOffsetCents", width: 110, render: (value) => `${value} 分` },
    { title: "兜底码", dataIndex: "fallbackPayUrl", width: 100, render: (value) => value ? <Tag color="success">已配置</Tag> : <Tag>未配置</Tag> },
    { title: "状态", dataIndex: "enabled", width: 100, render: (value) => value ? <Tag color="success">启用</Tag> : <Tag color="default">停用</Tag> },
    {
      title: "操作",
      key: "actions",
      width: 130,
      render: (_, record) => (
        <Space size="small">
          <Switch checked={record.enabled} onChange={(checked) => handleAccountToggle(record.id, checked)} />
          <Tooltip title="配置">
            <Button size="small" icon={<SettingOutlined />} onClick={() => setSettingsAccount(record)} />
          </Tooltip>
        </Space>
      )
    }
  ], [handleAccountToggle]);

  const deviceColumns = useMemo<Columns<Device>>(() => [
    { title: "设备 ID", dataIndex: "deviceId", ellipsis: true },
    { title: "账户", dataIndex: "accountCode", width: 110, render: (value) => value || "-" },
    { title: "在线", dataIndex: "online", width: 90, render: (value) => value ? <Tag color="success">在线</Tag> : <Tag>离线</Tag> },
    { title: "版本", dataIndex: "appVersion", width: 110, render: (value) => value || "-" },
    { title: "最后心跳", dataIndex: "lastSeenAt", width: 190, render: formatDate },
    { title: "启用", key: "enabled", width: 90, render: (_, record) => <Switch checked={record.enabled} onChange={(checked) => handleDeviceToggle(record.id, checked)} /> }
  ], [handleDeviceToggle]);

  const notificationColumns = useMemo<Columns<NotificationLog>>(() => [
    { title: "时间", dataIndex: "receivedAt", width: 190, render: formatDate },
    { title: "账户", dataIndex: "accountCode", width: 110 },
    { title: "设备", dataIndex: "deviceId", width: 160, ellipsis: true, render: (value) => value || "-" },
    { title: "金额", dataIndex: "actualAmount", width: 110, render: (value) => value || "-" },
    { title: "状态", dataIndex: "status", width: 110, render: (value) => <StatusTag value={String(value)} /> },
    { title: "订单号", dataIndex: "matchedOrderId", width: 220, ellipsis: true, render: (value) => value || "-" },
    { title: "原文", dataIndex: "rawText", ellipsis: true }
  ], []);

  const systemLogColumns = useMemo<Columns<SystemLog>>(() => [
    { title: "时间", dataIndex: "createdAt", width: 190, render: formatDate },
    { title: "级别", dataIndex: "level", width: 100, render: (value) => <StatusTag value={String(value)} /> },
    { title: "动作", dataIndex: "action", width: 180 },
    { title: "消息", dataIndex: "message", ellipsis: true }
  ], []);

  const callbackColumns = useMemo<Columns<CallbackLog>>(() => [
    { title: "订单号", dataIndex: "orderId", width: 220, ellipsis: true },
    { title: "状态", dataIndex: "status", width: 110, render: (value) => <StatusTag value={String(value)} /> },
    { title: "次数", dataIndex: "attempts", width: 80 },
    { title: "HTTP", dataIndex: "httpStatus", width: 90, render: (value) => value || "-" },
    { title: "下次重试", dataIndex: "nextRetryAt", width: 190, render: formatDate },
    { title: "地址", dataIndex: "url", ellipsis: true },
    { title: "操作", key: "actions", width: 90, fixed: "right", render: (_, record) => (
      <Tooltip title="重发">
        <Button size="small" icon={<SendOutlined />} disabled={record.status === "success"} onClick={() => handleRetryCallback(record.id)} />
      </Tooltip>
    ) }
  ], [handleRetryCallback]);

  const toolbar = useMemo(() => (
    <Space wrap>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setOrderOpen(true)}>订单</Button>
      <Button icon={<DatabaseOutlined />} onClick={() => setQrOpen(true)}>二维码</Button>
      <Button icon={<ApiOutlined />} onClick={() => setAccountOpen(true)}>账户</Button>
      <Tooltip title="刷新">
        <Button icon={<ReloadOutlined />} loading={loading || isPending} onClick={refresh} />
      </Tooltip>
      <Tooltip title="退出">
        <Button icon={<LockOutlined />} onClick={handleLogout} />
      </Tooltip>
    </Space>
  ), [handleLogout, isPending, loading, refresh]);

  const content = useMemo(() => {
    if (activeView === "dashboard") {
      return <DashboardView snapshot={snapshot} />;
    }
    if (activeView === "orders") {
      return (
        <section className="panel">
          <Table<Order> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.orders.items} columns={orderColumns} scroll={{ x: 1480 }} pagination={{ total: snapshot.orders.total, pageSize: snapshot.orders.limit, showSizeChanger: false }} />
        </section>
      );
    }
    if (activeView === "accounts") {
      return (
        <section className="panel">
          <Tabs items={[
            { key: "accounts", label: "账户", children: <Table<Account> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.accounts} columns={accountColumns} pagination={false} /> },
            { key: "devices", label: "设备", children: <Table<Device> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.devices} columns={deviceColumns} scroll={{ x: 900 }} pagination={false} /> }
          ]} />
        </section>
      );
    }
    if (activeView === "payments") {
      return (
        <section className="panel">
          <Tabs items={[
            { key: "occupied", label: "占用金额", children: <Table<AmountOccupation> size="small" rowKey="orderId" loading={loading || isPending} dataSource={snapshot.occupations.items} columns={occupationColumns} scroll={{ x: 900 }} pagination={{ total: snapshot.occupations.total, pageSize: snapshot.occupations.limit, showSizeChanger: false }} /> },
            { key: "qrcodes", label: "定额二维码", children: <Table<PresetQrCode> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.qrCodes.items} columns={qrColumns} scroll={{ x: 900 }} pagination={{ total: snapshot.qrCodes.total, pageSize: snapshot.qrCodes.limit, showSizeChanger: false }} /> }
          ]} />
        </section>
      );
    }
    if (activeView === "logs") {
      return (
        <section className="panel">
          <Tabs items={[
            { key: "notifications", label: "通知日志", children: <Table<NotificationLog> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.notifications.items} columns={notificationColumns} scroll={{ x: 1180 }} pagination={{ total: snapshot.notifications.total, pageSize: snapshot.notifications.limit, showSizeChanger: false }} /> },
            { key: "system", label: "系统日志", children: <Table<SystemLog> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.systemLogs.items} columns={systemLogColumns} pagination={{ total: snapshot.systemLogs.total, pageSize: snapshot.systemLogs.limit, showSizeChanger: false }} /> }
          ]} />
        </section>
      );
    }
    return (
      <section className="panel">
        <Table<CallbackLog> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.callbacks.items} columns={callbackColumns} scroll={{ x: 1120 }} pagination={{ total: snapshot.callbacks.total, pageSize: snapshot.callbacks.limit, showSizeChanger: false }} />
      </section>
    );
  }, [
    accountColumns,
    activeView,
    callbackColumns,
    deviceColumns,
    isPending,
    loading,
    notificationColumns,
    occupationColumns,
    orderColumns,
    qrColumns,
    snapshot,
    systemLogColumns
  ]);

  return (
    <Layout className="app-shell" hasSider>
      <Sider breakpoint="lg" collapsedWidth={0} width={224} theme="light" className="app-sider">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <div className="brand-title">PeerPay</div>
            <Text type="secondary">轻量收款服务</Text>
          </div>
        </div>
        <Menu mode="inline" selectedKeys={[activeView]} items={menuItems} onClick={({ key }) => setActiveView(key as ViewKey)} />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div>
            <Title level={3}>{viewTitles[activeView]}</Title>
            <Text type="secondary">SQLite · Bun · Android Listener</Text>
          </div>
          {toolbar}
        </Header>
        <Content className="app-content">{content}</Content>
      </Layout>
      <CreateOrderModal accounts={snapshot.accounts} open={orderOpen} onCancel={() => setOrderOpen(false)} onRefresh={refresh} />
      <QrCodeModal accounts={snapshot.accounts} open={qrOpen} onCancel={() => setQrOpen(false)} onRefresh={refresh} />
      <AccountModal open={accountOpen} onCancel={() => setAccountOpen(false)} onRefresh={refresh} />
      <AccountSettingsModal account={settingsAccount} open={Boolean(settingsAccount)} onCancel={() => setSettingsAccount(null)} onRefresh={refresh} />
    </Layout>
  );
}
