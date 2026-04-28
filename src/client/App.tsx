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
  QRCode,
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
  MobileOutlined,
  FileSearchOutlined,
  LockOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
  WalletOutlined
} from "@ant-design/icons";
import type {
  AmountOccupation,
  CallbackLog,
  Device,
  DeviceEnrollment,
  NotificationLog,
  Order,
  OrderStatus,
  PaymentPageData,
  PaymentPageSettings,
  PaymentAccount,
  PaymentChannel,
  PresetQrCode,
  SystemLog
} from "../shared/types";
import { DEFAULT_MAX_OFFSET_CENTS, DEFAULT_PAYMENT_CHANNEL, PAYMENT_CHANNEL_LABELS, PAYMENT_CHANNEL_OPTIONS } from "../shared/constants";
import {
  createDeviceEnrollment,
  createPaymentAccount,
  deleteQrCode,
  getAdminSession,
  getPaymentPage,
  loadSnapshot,
  loginAdmin,
  logoutAdmin,
  retryCallback,
  setDeviceEnabled,
  setPaymentAccountEnabled,
  setupAdmin,
  updateOrderStatus,
  updatePaymentAccountSettings,
  updatePaymentPageSettings,
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
  paymentPageSettings: { noticeEnabled: false, noticeTitle: "", noticeBody: "", noticeLinkText: "", noticeLinkUrl: null },
  paymentAccounts: [],
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
  { key: "accounts", icon: <ApiOutlined />, label: "收款账号" },
  { key: "payments", icon: <DatabaseOutlined />, label: "收款码" },
  { key: "logs", icon: <FileSearchOutlined />, label: "日志中心" },
  { key: "callbacks", icon: <CloudSyncOutlined />, label: "回调管理" }
];

const viewTitles: Record<ViewKey, string> = {
  dashboard: "仪表盘",
  orders: "订单管理",
  accounts: "收款账号",
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
  alipay: "支付宝",
  wechat: "微信",
  matched: "已匹配",
  unmatched: "未匹配",
  parse_failed: "解析失败",
  success: "成功",
  failed: "失败",
  info: "信息",
  warn: "警告",
  error: "异常"
};

const PAYMENT_PAGE_POLL_MS = 3_000;
const PAYMENT_PAGE_RETRY_MS = 5_000;

const paymentChannelOptions = PAYMENT_CHANNEL_OPTIONS.map((option) => ({
  label: option.label,
  value: option.value
}));

function PaymentChannelTag({ value }: { value: PaymentChannel | null | undefined }) {
  return value ? <Tag color={value === "wechat" ? "green" : "blue"}>{PAYMENT_CHANNEL_LABELS[value]}</Tag> : <Tag>未知</Tag>;
}

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

function paymentOrderIdFromPath() {
  const [, prefix, orderId] = window.location.pathname.split("/");
  return prefix === "pay" && orderId ? decodeURIComponent(orderId) : "";
}

function paymentQrStatus(status: OrderStatus) {
  if (status === "expired") {
    return "expired";
  }
  if (status === "paid" || status === "notified") {
    return "scanned";
  }
  return "active";
}

function PaymentPageContent({ page }: { page: PaymentPageData }) {
  const payable = page.status === "pending";
  const needsExactInput = page.amountInputRequired;
  const payTarget = page.targetPayUrl.startsWith("http") ? "_blank" : undefined;
  const channelTone = page.paymentChannel === "wechat" ? "wechat" : "alipay";
  const payModeText = page.payMode === "fallback" ? "通用码" : "定额码";
  const statusLabel = statusText[page.status] ?? page.status;

  return (
    <main className="pay-page">
      <section className="pay-shell">
        <header className="pay-masthead">
          <div>
            <p className="pay-eyebrow">PeerPay / {PAYMENT_CHANNEL_LABELS[page.paymentChannel]} Cashier</p>
            <Title>请支付 ¥{page.actualAmount}</Title>
            <Text>{page.subject || "订单付款"}</Text>
          </div>
          <div className="pay-status-chip" aria-live="polite">
            <span>当前状态</span>
            <strong>{statusLabel}</strong>
            <small>{payModeText}</small>
          </div>
        </header>

        <section className="pay-workspace">
          <div className={`pay-panel pay-qr-panel pay-terminal-${channelTone}`}>
            <div className="pay-panel-header">
              <h2>付款二维码</h2>
              <span className="pay-panel-mark">01</span>
            </div>
            <div className="pay-qr-body">
              <div className="pay-qr-stage">
                <QRCode
                  value={page.targetPayUrl}
                  status={paymentQrStatus(page.status)}
                  size={274}
                  bordered={false}
                  bgColor="#ffffff"
                  color="#181a17"
                />
              </div>
              <p className={needsExactInput ? "pay-ready-note pay-ready-note-warn" : "pay-ready-note"}>
                {needsExactInput
                  ? `请在付款应用中手动输入 ¥${page.actualAmount}，金额必须完全一致。`
                  : "扫码后直接按页面金额付款即可，系统会自动匹配到账通知。"}
              </p>
              <Button
                type="primary"
                size="large"
                block
                href={payable ? page.targetPayUrl : undefined}
                target={payTarget}
                disabled={!payable}
                icon={payable ? <SendOutlined /> : <CheckCircleOutlined />}
              >
                {payable ? "唤起付款应用" : statusLabel}
              </Button>
            </div>
          </div>

          <div className="pay-panel">
            <div className="pay-panel-header">
              <h2>订单信息</h2>
              <span className="pay-panel-mark">02</span>
            </div>
            <div className="pay-detail-body">
              <div className="pay-metrics">
                <div>
                  <span>付款方式</span>
                  <strong>{PAYMENT_CHANNEL_LABELS[page.paymentChannel]}</strong>
                </div>
                <div>
                  <span>订单金额</span>
                  <strong>¥{page.requestedAmount}</strong>
                </div>
                <div>
                  <span>收款模式</span>
                  <strong>{payModeText}</strong>
                </div>
              </div>

              <div className={needsExactInput ? "pay-warning pay-warning-strong" : "pay-warning"}>
                <div className="pay-warning-icon">{needsExactInput ? <BellOutlined /> : <CheckCircleOutlined />}</div>
                <div>
                  <Text strong>{needsExactInput ? "请手动输入精确金额" : "金额已写入二维码"}</Text>
                  <p>
                    {needsExactInput
                      ? `付款时必须填写 ¥${page.actualAmount}。付错、少付或多付，系统无法自动识别。`
                      : "扫码后按页面金额付款即可，系统会按当前订单自动匹配到账通知。"}
                  </p>
                </div>
              </div>

              <dl className="pay-facts">
                <div>
                  <dt><WalletOutlined /> 收款账号</dt>
                  <dd>{page.paymentAccountName} · {page.paymentAccountCode}</dd>
                </div>
                <div>
                  <dt><ClockCircleOutlined /> 过期时间</dt>
                  <dd>{formatDate(page.expireAt)}</dd>
                </div>
                {page.merchantOrderId ? (
                  <div>
                    <dt><FileSearchOutlined /> 商户单号</dt>
                    <dd>{page.merchantOrderId}</dd>
                  </div>
                ) : null}
              </dl>

              {page.notice ? (
                <aside className="pay-notice">
                  {page.notice.title ? <Text strong>{page.notice.title}</Text> : null}
                  {page.notice.body ? <p>{page.notice.body}</p> : null}
                  {page.notice.linkUrl ? <a href={page.notice.linkUrl} target="_blank" rel="noreferrer">{page.notice.linkText || "查看详情"}</a> : null}
                </aside>
              ) : null}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

export function PaymentPageApp() {
  const [page, setPage] = useState<PaymentPageData | null>(null);
  const [error, setError] = useState("");
  const orderId = paymentOrderIdFromPath();

  useEffect(() => {
    if (!orderId) {
      setError("付款链接无效");
      return;
    }

    document.title = "PeerPay 付款";
    let cancelled = false;
    let timer: number | undefined;

    const loadPaymentPage = async () => {
      try {
        const nextPage = await getPaymentPage(orderId);
        if (cancelled) {
          return;
        }
        setPage(nextPage);
        setError("");
        if (nextPage.status === "pending") {
          timer = window.setTimeout(loadPaymentPage, PAYMENT_PAGE_POLL_MS);
        }
      } catch (nextError) {
        if (cancelled) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : "付款页加载失败");
        timer = window.setTimeout(loadPaymentPage, PAYMENT_PAGE_RETRY_MS);
      }
    };

    void loadPaymentPage();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [orderId]);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#0f6b55",
          colorSuccess: "#16803c",
          colorWarning: "#bd6f1d",
          colorError: "#bd3f2a",
          borderRadius: 8,
          fontFamily: "Avenir Next, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
        }
      }}
    >
      {page ? <PaymentPageContent page={page} /> : (
        <main className="pay-page pay-loading">
          <div className="pay-panel">
            <Title level={3}>{error || "正在加载付款页"}</Title>
            <Text type="secondary">{error ? "请检查付款链接，或联系商户重新创建订单。" : "请稍候"}</Text>
          </div>
        </main>
      )}
    </ConfigProvider>
  );
}

interface ModalProps {
  paymentAccounts: PaymentAccount[];
  open: boolean;
  onCancel: () => void;
  onRefresh: () => void;
}

function QrCodeModal({ paymentAccounts, open, onCancel, onRefresh }: ModalProps) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const paymentAccountOptions = useMemo(() => paymentAccounts.map((account) => ({
    label: `${PAYMENT_CHANNEL_LABELS[account.paymentChannel]} · ${account.name} (${account.code})`,
    value: account.code
  })), [paymentAccounts]);

  const handleFinish = useCallback(async (values: { paymentAccountCode: string; lines: string }) => {
    const items = normalizeQrLines(values.lines);
    if (items.some((item) => !item.amount || !item.payUrl)) {
      message.error("二维码配置格式无效");
      return;
    }

    setSaving(true);
    try {
      const result = await upsertQrCodes({ paymentAccountCode: values.paymentAccountCode, items });
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
        <Form.Item name="paymentAccountCode" label="收款账号" rules={[{ required: true, message: "请选择收款账号" }]}>
          <Select options={paymentAccountOptions} placeholder="选择收款账号" />
        </Form.Item>
        <Form.Item name="lines" label="二维码" rules={[{ required: true, message: "请输入二维码配置" }]}>
          <TextArea rows={10} placeholder={"10.00 https://pay.example/10.00\n10.01 wxp://xxxxxxxxxxxx"} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function DeviceEnrollmentModal({ paymentAccounts, open, onCancel, onRefresh }: ModalProps) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const [enrollment, setEnrollment] = useState<DeviceEnrollment | null>(null);
  const paymentAccountOptions = useMemo(() => paymentAccounts.map((account) => ({
    label: `${PAYMENT_CHANNEL_LABELS[account.paymentChannel]} · ${account.name} (${account.code})`,
    value: account.code
  })), [paymentAccounts]);
  const pairingUrl = useMemo(() => {
    if (!enrollment) {
      return "";
    }

    return new URL(enrollment.pairingUrl, window.location.origin).toString();
  }, [enrollment]);

  useEffect(() => {
    if (!open) {
      setEnrollment(null);
      form.resetFields();
    }
  }, [form, open]);

  const handleFinish = useCallback(async (values: { paymentAccountCode: string; name?: string; ttlMinutes: number }) => {
    setSaving(true);
    try {
      const result = await createDeviceEnrollment(values);
      setEnrollment(result);
      message.success("配对二维码已生成");
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "配对二维码生成失败");
    } finally {
      setSaving(false);
    }
  }, [message, onRefresh]);

  return (
    <Modal
      title="设备配对"
      open={open}
      confirmLoading={saving}
      destroyOnHidden
      okText={enrollment ? "重新生成" : "生成"}
      cancelText="关闭"
      onOk={form.submit}
      onCancel={onCancel}
      width={680}
    >
      <Form form={form} layout="vertical" initialValues={{ ttlMinutes: 30 }} onFinish={handleFinish}>
        <Form.Item name="paymentAccountCode" label="收款账号" rules={[{ required: true, message: "请选择收款账号" }]}>
          <Select options={paymentAccountOptions} placeholder="选择收款账号" />
        </Form.Item>
        <Form.Item name="name" label="设备备注">
          <Input allowClear />
        </Form.Item>
        <Form.Item name="ttlMinutes" label="有效分钟数" rules={[{ required: true, message: "请输入有效分钟数" }]}>
          <InputNumber min={1} max={1440} precision={0} className="full-width" />
        </Form.Item>
      </Form>
      {enrollment ? (
        <div className="pairing-result">
          <QRCode value={pairingUrl} size={220} />
          <div className="pairing-copy">
            <Text strong>配对 URL</Text>
            <Text copyable className="break-text">{pairingUrl}</Text>
            <Text type="secondary">通用 APK 扫描这个二维码后，会连接到当前私有服务器并完成配对。</Text>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function PaymentAccountModal({ open, onCancel, onRefresh }: Omit<ModalProps, "paymentAccounts">) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);

  const handleFinish = useCallback(async (values: { code: string; name: string; paymentChannel: PaymentChannel; priority: number; maxOffsetCents: number; fallbackPayUrl?: string }) => {
    setSaving(true);
    try {
      await createPaymentAccount({
        ...values,
        fallbackPayUrl: values.fallbackPayUrl || null
      });
      message.success("收款账号已创建");
      form.resetFields();
      onCancel();
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "收款账号创建失败");
    } finally {
      setSaving(false);
    }
  }, [form, message, onCancel, onRefresh]);

  return (
    <Modal title="创建收款账号" open={open} confirmLoading={saving} destroyOnHidden okText="创建" cancelText="取消" onOk={form.submit} onCancel={onCancel}>
      <Form form={form} layout="vertical" initialValues={{ paymentChannel: DEFAULT_PAYMENT_CHANNEL, priority: 100, maxOffsetCents: DEFAULT_MAX_OFFSET_CENTS }} onFinish={handleFinish}>
        <Form.Item name="code" label="编码" rules={[{ required: true, message: "请输入编码" }]}>
          <Input allowClear />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
          <Input allowClear />
        </Form.Item>
        <Form.Item name="paymentChannel" label="付款方式" rules={[{ required: true, message: "请选择付款方式" }]}>
          <Select options={paymentChannelOptions} />
        </Form.Item>
        <Form.Item name="priority" label="优先级" rules={[{ required: true, message: "请输入优先级" }]}>
          <InputNumber min={0} max={999999} precision={0} className="full-width" />
        </Form.Item>
        <Form.Item name="maxOffsetCents" label="最大偏移分" rules={[{ required: true, message: "请输入最大偏移" }]}>
          <InputNumber min={0} max={9999} precision={0} className="full-width" />
        </Form.Item>
        <Form.Item name="fallbackPayUrl" label="兜底收款码 URL">
          <Input allowClear placeholder="支持 https://... 或 wxp://..." />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface PaymentAccountSettingsModalProps {
  account: PaymentAccount | null;
  open: boolean;
  onCancel: () => void;
  onRefresh: () => void;
}

function PaymentAccountSettingsModal({ account, open, onCancel, onRefresh }: PaymentAccountSettingsModalProps) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account && open) {
      form.setFieldsValue({
        code: account.code,
        name: account.name,
        paymentChannel: account.paymentChannel,
        priority: account.priority,
        maxOffsetCents: account.maxOffsetCents,
        fallbackPayUrl: account.fallbackPayUrl
      });
    }
  }, [account, form, open]);

  const handleFinish = useCallback(async (values: { code: string; name: string; paymentChannel: PaymentChannel; priority: number; maxOffsetCents: number; fallbackPayUrl?: string }) => {
    if (!account) {
      return;
    }
    setSaving(true);
    try {
      await updatePaymentAccountSettings(account.id, {
        ...values,
        fallbackPayUrl: values.fallbackPayUrl || null
      });
      message.success("收款账号配置已更新");
      onCancel();
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "收款账号配置更新失败");
    } finally {
      setSaving(false);
    }
  }, [account, message, onCancel, onRefresh]);

  return (
    <Modal title="收款账号配置" open={open} confirmLoading={saving} destroyOnHidden okText="保存" cancelText="取消" onOk={form.submit} onCancel={onCancel}>
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item name="code" label="编码" rules={[{ required: true, message: "请输入编码" }]}>
          <Input allowClear />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
          <Input allowClear />
        </Form.Item>
        <Form.Item name="paymentChannel" label="付款方式" rules={[{ required: true, message: "请选择付款方式" }]}>
          <Select options={paymentChannelOptions} />
        </Form.Item>
        <Form.Item name="priority" label="优先级" rules={[{ required: true, message: "请输入优先级" }]}>
          <InputNumber min={0} max={999999} precision={0} className="full-width" />
        </Form.Item>
        <Form.Item name="maxOffsetCents" label="最大偏移分" rules={[{ required: true, message: "请输入最大偏移" }]}>
          <InputNumber min={0} max={9999} precision={0} className="full-width" />
        </Form.Item>
        <Form.Item name="fallbackPayUrl" label="兜底收款码 URL">
          <Input allowClear placeholder="支持 https://... 或 wxp://..." />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface PaymentPageSettingsModalProps {
  settings: PaymentPageSettings;
  open: boolean;
  onCancel: () => void;
  onRefresh: () => void;
}

function PaymentPageSettingsModal({ settings, open, onCancel, onRefresh }: PaymentPageSettingsModalProps) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.setFieldsValue(settings);
    }
  }, [form, open]);

  const handleFinish = useCallback(async (values: PaymentPageSettings) => {
    setSaving(true);
    try {
      await updatePaymentPageSettings({
        ...values,
        noticeLinkUrl: values.noticeLinkUrl || null
      });
      message.success("付款页配置已更新");
      onCancel();
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "付款页配置更新失败");
    } finally {
      setSaving(false);
    }
  }, [message, onCancel, onRefresh]);

  return (
    <Modal title="付款页配置" open={open} confirmLoading={saving} destroyOnHidden okText="保存" cancelText="取消" onOk={form.submit} onCancel={onCancel}>
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item name="noticeEnabled" label="公告位" valuePropName="checked">
          <Switch checkedChildren="开" unCheckedChildren="关" />
        </Form.Item>
        <Form.Item name="noticeTitle" label="公告标题">
          <Input allowClear maxLength={80} placeholder="例如：春节期间到账说明" />
        </Form.Item>
        <Form.Item name="noticeBody" label="公告内容">
          <TextArea rows={4} maxLength={500} showCount placeholder="可填写活动、客服、到账延迟或风险提示等内容" />
        </Form.Item>
        <Form.Item name="noticeLinkText" label="链接文案">
          <Input allowClear maxLength={40} placeholder="例如：查看详情" />
        </Form.Item>
        <Form.Item name="noticeLinkUrl" label="链接地址">
          <Input allowClear placeholder="https://example.com/notice" />
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
          <Text type="secondary">兜底码 {stats.amountPool.fallbackAccounts}</Text>
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
            { title: "收款账号", dataIndex: "paymentAccountCode", width: 120 },
            { title: "实付金额", dataIndex: "actualAmount", width: 110 },
            { title: "方式", dataIndex: "paymentChannel", width: 90, render: (value) => <PaymentChannelTag value={value} /> },
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
  const [qrOpen, setQrOpen] = useState(false);
  const [previewQrCode, setPreviewQrCode] = useState<PresetQrCode | null>(null);
  const [deviceEnrollOpen, setDeviceEnrollOpen] = useState(false);
  const [paymentAccountOpen, setPaymentAccountOpen] = useState(false);
  const [paymentPageSettingsOpen, setPaymentPageSettingsOpen] = useState(false);
  const [settingsPaymentAccount, setSettingsPaymentAccount] = useState<PaymentAccount | null>(null);

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

  const handlePaymentAccountToggle = useCallback(async (id: number, enabled: boolean) => {
    try {
      await setPaymentAccountEnabled(id, enabled);
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "收款账号状态更新失败");
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
    { title: "收款账号", dataIndex: "paymentAccountCode", width: 120, render: (value) => value || "-" },
    { title: "方式", dataIndex: "paymentChannel", width: 90, render: (value) => <PaymentChannelTag value={value} /> },
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
    { title: "收款账号", dataIndex: "paymentAccountCode", width: 120, render: (value) => value || "-" },
    { title: "方式", dataIndex: "paymentChannel", width: 90, render: (value) => <PaymentChannelTag value={value} /> },
    { title: "订单金额", dataIndex: "requestedAmount", width: 110 },
    { title: "占用金额", dataIndex: "actualAmount", width: 110 },
    { title: "付款", dataIndex: "payMode", width: 110, render: (value) => <StatusTag value={String(value)} /> },
    { title: "过期时间", dataIndex: "expireAt", width: 190, render: formatDate }
  ], []);

  const qrColumns = useMemo<Columns<PresetQrCode>>(() => [
    { title: "收款账号", dataIndex: "paymentAccountCode", width: 120, render: (value) => value || "-" },
    { title: "方式", dataIndex: "paymentChannel", width: 90, render: (value) => <PaymentChannelTag value={value} /> },
    { title: "金额", dataIndex: "amount", width: 110 },
    {
      title: "付款 URL",
      dataIndex: "payUrl",
      ellipsis: true,
      render: (value: string, record) => (
        <Space size="small">
          <Text ellipsis className="table-url">{value}</Text>
          <Tooltip title="查看二维码">
            <Button size="small" icon={<QrcodeOutlined />} onClick={() => setPreviewQrCode(record)} />
          </Tooltip>
        </Space>
      )
    },
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

  const paymentAccountColumns = useMemo<Columns<PaymentAccount>>(() => [
    { title: "编码", dataIndex: "code", width: 140 },
    { title: "名称", dataIndex: "name" },
    { title: "方式", dataIndex: "paymentChannel", width: 90, render: (value) => <PaymentChannelTag value={value} /> },
    { title: "优先级", dataIndex: "priority", width: 90 },
    { title: "最大偏移", dataIndex: "maxOffsetCents", width: 110, render: (value) => `${value} 分` },
    { title: "兜底码", dataIndex: "fallbackPayUrl", width: 100, render: (value) => value ? <Tag color="success">已配置</Tag> : <Tag>未配置</Tag> },
    { title: "状态", dataIndex: "enabled", width: 100, render: (value) => value ? <Tag color="success">启用</Tag> : <Tag color="default">停用</Tag> },
    {
      title: "操作",
      key: "actions",
      width: 130,
      render: (_, record) => (
        <Space size="small">
          <Switch checked={record.enabled} onChange={(checked) => handlePaymentAccountToggle(record.id, checked)} />
          <Tooltip title="配置">
            <Button size="small" icon={<SettingOutlined />} onClick={() => setSettingsPaymentAccount(record)} />
          </Tooltip>
        </Space>
      )
    }
  ], [handlePaymentAccountToggle]);

  const deviceColumns = useMemo<Columns<Device>>(() => [
    { title: "设备 ID", dataIndex: "deviceId", width: 180, ellipsis: true },
    { title: "备注", dataIndex: "name", width: 140, ellipsis: true, render: (value) => value || "-" },
    {
      title: "绑定账号",
      dataIndex: "paymentAccounts",
      width: 240,
      render: (value: Device["paymentAccounts"]) => value.length
        ? <Space size={[4, 4]} wrap>{value.map((account) => <Tag key={account.id}>{PAYMENT_CHANNEL_LABELS[account.paymentChannel]} · {account.code}</Tag>)}</Space>
        : "-"
    },
    { title: "在线", dataIndex: "online", width: 90, render: (value) => value ? <Tag color="success">在线</Tag> : <Tag>离线</Tag> },
    { title: "版本", dataIndex: "appVersion", width: 110, render: (value) => value || "-" },
    { title: "配对时间", dataIndex: "pairedAt", width: 190, render: formatDate },
    { title: "最后心跳", dataIndex: "lastSeenAt", width: 190, render: formatDate },
    { title: "启用", key: "enabled", width: 90, render: (_, record) => <Switch checked={record.enabled} onChange={(checked) => handleDeviceToggle(record.id, checked)} /> }
  ], [handleDeviceToggle]);

  const notificationColumns = useMemo<Columns<NotificationLog>>(() => [
    { title: "时间", dataIndex: "receivedAt", width: 190, render: formatDate },
    { title: "收款账号", dataIndex: "paymentAccountCode", width: 120, render: (value) => value || "-" },
    { title: "设备", dataIndex: "deviceId", width: 160, ellipsis: true, render: (value) => value || "-" },
    { title: "方式", dataIndex: "paymentChannel", width: 90, render: (value) => <PaymentChannelTag value={value} /> },
    { title: "包名", dataIndex: "packageName", width: 190, ellipsis: true, render: (value) => value || "-" },
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
      <Button type="primary" icon={<MobileOutlined />} onClick={() => setDeviceEnrollOpen(true)}>设备配对</Button>
      <Button icon={<DatabaseOutlined />} onClick={() => setQrOpen(true)}>二维码</Button>
      <Button icon={<ApiOutlined />} onClick={() => setPaymentAccountOpen(true)}>收款账号</Button>
      <Button icon={<SettingOutlined />} onClick={() => setPaymentPageSettingsOpen(true)}>付款页</Button>
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
          <Table<Order> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.orders.items} columns={orderColumns} scroll={{ x: 1570 }} pagination={{ total: snapshot.orders.total, pageSize: snapshot.orders.limit, showSizeChanger: false }} />
        </section>
      );
    }
    if (activeView === "accounts") {
      return (
        <section className="panel">
          <Tabs items={[
            { key: "accounts", label: "收款账号", children: <Table<PaymentAccount> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.paymentAccounts} columns={paymentAccountColumns} pagination={false} /> },
            { key: "devices", label: "设备", children: <Table<Device> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.devices} columns={deviceColumns} scroll={{ x: 1100 }} pagination={false} /> }
          ]} />
        </section>
      );
    }
    if (activeView === "payments") {
      return (
        <section className="panel">
          <Tabs items={[
            { key: "occupied", label: "占用金额", children: <Table<AmountOccupation> size="small" rowKey="orderId" loading={loading || isPending} dataSource={snapshot.occupations.items} columns={occupationColumns} scroll={{ x: 990 }} pagination={{ total: snapshot.occupations.total, pageSize: snapshot.occupations.limit, showSizeChanger: false }} /> },
            { key: "qrcodes", label: "定额二维码", children: <Table<PresetQrCode> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.qrCodes.items} columns={qrColumns} scroll={{ x: 990 }} pagination={{ total: snapshot.qrCodes.total, pageSize: snapshot.qrCodes.limit, showSizeChanger: false }} /> }
          ]} />
        </section>
      );
    }
    if (activeView === "logs") {
      return (
        <section className="panel">
          <Tabs items={[
            { key: "notifications", label: "通知日志", children: <Table<NotificationLog> size="small" rowKey="id" loading={loading || isPending} dataSource={snapshot.notifications.items} columns={notificationColumns} scroll={{ x: 1460 }} pagination={{ total: snapshot.notifications.total, pageSize: snapshot.notifications.limit, showSizeChanger: false }} /> },
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
    activeView,
    callbackColumns,
    deviceColumns,
    isPending,
    loading,
    notificationColumns,
    occupationColumns,
    orderColumns,
    paymentAccountColumns,
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
      <QrCodeModal paymentAccounts={snapshot.paymentAccounts} open={qrOpen} onCancel={() => setQrOpen(false)} onRefresh={refresh} />
      <DeviceEnrollmentModal paymentAccounts={snapshot.paymentAccounts} open={deviceEnrollOpen} onCancel={() => setDeviceEnrollOpen(false)} onRefresh={refresh} />
      <PaymentAccountModal open={paymentAccountOpen} onCancel={() => setPaymentAccountOpen(false)} onRefresh={refresh} />
      <PaymentAccountSettingsModal account={settingsPaymentAccount} open={Boolean(settingsPaymentAccount)} onCancel={() => setSettingsPaymentAccount(null)} onRefresh={refresh} />
      <PaymentPageSettingsModal settings={snapshot.paymentPageSettings} open={paymentPageSettingsOpen} onCancel={() => setPaymentPageSettingsOpen(false)} onRefresh={refresh} />
      <Modal title="查看二维码" open={Boolean(previewQrCode)} footer={null} destroyOnHidden onCancel={() => setPreviewQrCode(null)}>
        {previewQrCode ? (
          <div className="qr-preview">
            <QRCode value={previewQrCode.payUrl} size={220} bgColor="#ffffff" />
            <div className="qr-preview-meta">
              <Text strong>{previewQrCode.amount}</Text>
              <PaymentChannelTag value={previewQrCode.paymentChannel} />
              <Text type="secondary">{previewQrCode.paymentAccountName} · {previewQrCode.paymentAccountCode}</Text>
              <Text className="break-text">{previewQrCode.payUrl}</Text>
            </div>
          </div>
        ) : null}
      </Modal>
    </Layout>
  );
}
