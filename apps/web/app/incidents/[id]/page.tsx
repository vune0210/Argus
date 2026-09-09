import { ExecutionConsole } from "../../../components/execution-console";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <ExecutionConsole incidentId={(await params).id} />;
}
