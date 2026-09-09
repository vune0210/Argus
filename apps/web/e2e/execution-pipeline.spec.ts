import { expect, test, type Route } from "@playwright/test";

test("diagnostic run, realtime region timeline and incident open/resolve", async ({ page }) => {
  let health = "HEALTHY";
  let diagnostic = false;
  let incident: Record<string, unknown> | undefined;
  const pending: Route[] = [];
  const time = "2026-09-05T00:00:00Z";
  await page.context().addCookies([{ name:"argus_mock_user", value:"1", domain:"localhost", path:"/" }]);
  await page.route("**/api/backend/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/backend/api/v1/", "");
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path.endsWith("/events")) { pending.push(route); return; }
    if (path === "auth/bootstrap") return json({ user:{id:"owner",email:"owner@example.test"},organization:{id:"org",name:"Test workspace",role:"OWNER"} });
    if (path === "monitors/monitor/run") { diagnostic=true;return route.fulfill({status:202,json:{id:"execution"}}); }
    if (path === "monitors/monitor") return json({ id:"monitor",name:"Checkout",healthState:health,config:{url:"https://example.com"} });
    if (path === "monitors/monitor/snapshot") return json({ organizationId:"org",monitorId:"monitor",monitorVersion:1,healthState:health,observedAt:time,regions:["ap-southeast-1","ap-northeast-1","eu-central-1"].map(region=>({region,executionId:"execution",executionSequence:"1",outcome:health === "DOWN"?"FAIL":"PASS",latencyMs:25,completedAt:time,receivedAt:time,freshness:"FRESH",heartbeat:{status:"ALIVE",lastSeenAt:time}})) });
    if (path === "monitors/monitor/executions") return json({ items:[{id:"execution",kind:diagnostic?"MANUAL":"SCHEDULED",status:"COMPLETED",scheduledAt:time,observation:health === "DOWN"?"QUORUM_FAILURE":"QUORUM_PASS"}] });
    if (path === "executions/execution") return json({id:"execution",targets:["ap-southeast-1","ap-northeast-1","eu-central-1"].map((region)=>({id:region,region,status:"COMPLETED",result:{outcome:health === "DOWN"?"FAIL":"PASS",durationMs:25,http:{statusCode:health === "DOWN"?503:200},...(health === "DOWN"?{errorCode:"ASSERTION"}:{})}}))});
    if (path === "incidents") return json({items:incident?[incident]:[]});
    return route.fulfill({status:404,json:{message:"not found"}});
  });
  async function event(type: string) {
    await expect.poll(()=>pending.length).toBeGreaterThan(0);
    await Promise.all(pending.splice(0).map(route => route.fulfill({status:200,contentType:"text/event-stream",body:`id: ${Date.now()}\nevent: ${type}\ndata: ${JSON.stringify({type,organizationId:"org",payload:{}})}\n\n`})));
  }
  await page.goto("/monitors/monitor");
  await expect(page.getByText("HEALTHY",{exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"eu-central-1"})).toBeVisible();
  await page.getByRole("button",{name:"Run now"}).click();
  await expect(page.getByRole("cell",{name:"Diagnostic",exact:true})).toBeVisible();
  await expect(page.getByText("HEALTHY",{exact:true})).toBeVisible();
  health="DOWN";incident={id:"incident",monitorId:"monitor",openedAt:time,resolvedAt:null};
  await event("incident.opened");
  await expect(page.getByText("DOWN",{exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:/^Open ·/})).toBeVisible();
  await expect(page.getByText("ASSERTION",{exact:true})).toHaveCount(3);
  health="HEALTHY";incident.resolvedAt="2026-09-05T00:02:00Z";
  await event("incident.resolved");
  await expect(page.getByRole("link",{name:/^Resolved ·/})).toBeVisible();
  await expect(page.getByText("HEALTHY",{exact:true})).toBeVisible();
  await page.close();
});

test("viewer can read incident history without mutation controls",async({page})=>{
  await page.context().addCookies([{name:"argus_mock_user",value:"1",domain:"localhost",path:"/"}]);
  await page.route("**/api/backend/**",async(route)=>{
    const url=route.request().url();
    if(url.endsWith("auth/bootstrap"))return route.fulfill({json:{user:{email:"viewer@example.test"},organization:{id:"org",role:"VIEWER"}}});
    if(url.endsWith("events"))return route.fulfill({status:200,contentType:"text/event-stream",body:": heartbeat\n\n"});
    return route.fulfill({json:{items:[]}});
  });
  await page.goto("/incidents");
  await expect(page.getByText("No incidents.")).toBeVisible();
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
});
