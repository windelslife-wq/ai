import { AdminWorkspace } from "../../components/admin/AdminWorkspace";
import { seoSettings } from "../../lib/seo";
export default function AdminPage() { return <AdminWorkspace seo={seoSettings} />; }
