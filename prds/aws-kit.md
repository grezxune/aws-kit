---
title: AWS kit
status: draft
---

## Problem

Vercel and Convex host most of the developer's apps and stay the default. Some projects need something from AWS, and which service is not known in advance. Today each project provisions AWS by hand or through an in-app admin setup tool, signed in with a long-lived IAM access key. Nothing records which resources belong to which project, so teardown is manual and forgotten resources keep billing. Everything also sits in one account, with no path to give a project its own account once it has real users or a paying client. The developer wants one local tool, started from the root sign-in, that agents drive to create accounts and provision resources. They want to ask an agent for any AWS service in plain language, get it deployed and connected to the app, remove it with one request, and move a project to its own account later without rebuilding it.

## Goals

- A project gets its own AWS account with one command, ready for stacks in under 15 minutes.
- Any AWS service with an API can be added to a project through one flow, with no change to the kit.
- Every resource traces to one project stage. Destroying a stage leaves nothing tagged with it.
- A project stage moves from the shared account to its own account by changing one config value and running one command. Stateless resources need no manual steps.
- One command lists every project, stage, account, resource type, and month-to-date cost.
- The laptop and Vercel hold no long-lived AWS access keys.

## Non-goals

- A catalog of per-service constructs. The kit holds rules that apply to every resource of every type. A recipe gets added only after the same pattern has been written twice.
- Zero-downtime moves for stateful resources. Some services can do it with replication, but the kit does not promise it.
- Hosting Next.js on AWS. Vercel does this with less work.
- A custom MCP server. The AWS MCP Server already gives agents API access and current docs.
- A web dashboard. The list command and the AWS console cover it until that proves too little.
- Terraform, Pulumi, or other clouds. One tool keeps the agent's instructions short.
- CI deploys. Infra deploys from the laptop in the first release.

## Users and flows

One developer, working through Claude Code inside a project repo.

Set up, once:

1. Sign in as root in the browser with `aws login`.
2. Run bootstrap. It creates the organization and an operator user.
3. Turn on console sign-in and MFA for the operator, then sign in as the operator with `aws login`. Root signs out.

Add an account: ask for one by name. The agent shows the name and email, the developer confirms, the agent creates it and makes it ready.

A request can mix infrastructure and app changes, such as "add a bucket behind CloudFront and use it for all file uploads". The agent does both in one session. The app changes follow that project's own rules and PRDs.

Add anything:

1. In a project repo, ask for it. "Add a queue and a worker." "Add Postgres with pgvector." "Put an agent on AgentCore."
2. The agent reads current AWS docs for that service, then adds it to `infra/` in that repo.
3. The agent shows the AWS resources it will add, change, and remove, the estimated monthly cost, and how each resource would move to another account.
4. The developer confirms.
5. The agent deploys, sets the app's env vars, and runs a check from the app.

List: ask what is running, get one table across all projects and accounts.

Remove: ask to tear down a project stage. The agent shows what it will delete, the developer confirms, the agent destroys the stack and checks that nothing tagged remains.

Move: ask to give a project stage its own account. The agent shows a plan per resource, the developer confirms, the agent creates the account, deploys there, copies data, switches the app over, and keeps the old stack until the developer says to delete it.

## Requirements

### R1 (P0): Sign-in uses a browser session and no stored access key
- Given a root sign-in, when bootstrap runs and is confirmed, then an organization and an operator user with administrator access exist. Run again, it changes nothing.
- Given a new terminal, when the agent first needs AWS, then one browser sign-in as the operator covers the rest of the working day.
- Given the root profile, when a command needs a member account, then it fails with `root_cannot_assume` and says to sign in as the operator.
- Given setup is complete, when `~/.aws/credentials` is inspected, then it holds no access key.

### R2 (P0): One command makes any account ready
- Given a signed-in session and any AWS account, shared or project, when the ready command runs, then the account has CDK bootstrap resources, a monthly budget with an email alert, Vercel registered as an OIDC identity provider, and `project` and `stage` active as cost allocation tags.
- Given an account that is already ready, when the command runs again, then it changes nothing and exits 0.

### R3 (P0): Any AWS service can be added through the same flow
- Given a service with CloudFormation resource types, when the developer asks for it and confirms, then it deploys as part of the project's stack.
- Given a feature that has an API but no CloudFormation support, when the developer asks for it, then the agent wraps the API call so the resource is created and deleted with the stack.
- Given a service the agent has not used in this project, when it writes the infra code, then it has first read that service's current docs through the AWS MCP Server.
- Given three unlike services picked at acceptance time, one stateless, one stateful, and one without CloudFormation support, when each is added, deployed, and destroyed, then all three succeed and the kit contains no code that names any of them.

### R4 (P0): Every resource belongs to a project stage
- Given any resource deployed through the kit, when its tags are read, then it carries `project` and `stage`.
- Given deployed stacks, when the list command runs, then it prints each project, stage, account, region, resource types, stack status, and month-to-date cost.
- Given a resource that carries a project tag but sits in no stack, when the list command runs, then it flags the resource as untracked.

### R5 (P0): The app is connected without copied secrets
- Given a stack value marked for the app, when deploy succeeds, then that value is present in the Vercel project's env vars. The `prod` stage writes to Production. Every other stage writes to Preview and Development.
- Given a Vercel deployment, when it calls any AWS service, then it authenticates through Vercel OIDC as that project stage's app role, and the Vercel project has no `AWS_ACCESS_KEY_ID`.
- Given a resource the app has not been granted, when the app calls it, then AWS denies the call.

### R6 (P0): Nothing deploys or deletes without a shown diff and a yes
- Given any change, when the agent wants to deploy, then it first shows the resources to add, change, and remove plus the estimated monthly cost, and waits for confirmation.
- Given a change that has not been diffed, when the deploy command runs, then it exits with an error and deploys nothing.

### R7 (P0): One request removes a project stage
- Given a non-prod stage, when the developer confirms destroy, then the stack is gone, a tag query for that project and stage returns nothing, and the matching Vercel env vars are removed.
- Given a prod stage, when the developer confirms destroy, then every resource that supports a final snapshot leaves one, and the command prints their names.

### R8 (P0): Prod data is protected by default, whatever the service
- Given a stage named `prod`, when the stack deploys, then stack termination protection is on and every stateful resource is set to survive stack deletion or leave a snapshot.
- Given a resource type the kit has not classified, when it deploys to prod, then the kit treats it as stateful.
- Given a prod stage, when destroy is requested, then the command requires the project name typed back before it proceeds.
- Given any other stage, when destroy is confirmed, then data is deleted with no extra step.

### R9 (P0): Every stack can deploy to a different account without a code change
- Given a project stack, when it is synthesized, then it contains no literal account ID, no reference to another project's stack, and no fixed name for a globally unique resource. A violation fails the diff step and names the resource.
- Given a stage whose account in config changes to another ready account, when deploy runs, then the same code deploys there.
- Given any diff, when it is shown, then each resource is labeled with how it would move: recreate, copy data with a named method, or cannot move as-is with the reason.

### R10 (P1): A project stage can move to its own account
- Given a stage in the shared account, when a move is requested, then the kit prints a plan listing each resource, its move method, and the expected downtime, and changes nothing until confirmed.
- Given the plan is confirmed, when the move runs, then it creates the account if needed, makes it ready, deploys the stack, copies data for each stateful resource, switches the app's env vars to the new account, and leaves the old stack in place.
- Given a move that stopped partway, when it runs again, then it resumes from the last completed step.
- Given a scratch project with one database and one bucket that both hold data, when it moves to a new account, then row counts and object counts match and the app works against the new account.
- Given the developer confirms the new account works, when cleanup runs, then the old stack is destroyed under the rules in R7.

### R11 (P1): Experiments can skip the stack and be adopted later
- Given the agent creates a resource through a direct API call, when the call is made, then the resource is tagged with the project and the stage `scratch`.
- Given untracked scratch resources, when the developer asks to keep them, then they are brought into the project's stack without being recreated. When the developer asks to discard them, then they are deleted.

### R12 (P1): Prod resources cannot be deleted by the everyday session
- Given an account that is ready, when the signed-in session tries to delete a stack or stateful resource tagged `stage=prod`, then AWS denies it.
- Given the developer assumes the break-glass role, when the same delete runs, then it succeeds.
- Given a new project, when it deploys, then the guard applies with no per-project setup.

### R13 (P2): Repeated patterns become recipes
- Given the same pattern has been written in two projects, when the developer asks, then it is added to the kit as a reusable construct and both projects can switch to it without replacing resources.

### R14 (P2): Existing hand-made resources can be adopted
- Given a bucket and distribution from an older project, when the developer asks to adopt them, then they join that project's stack without being recreated.

### R15 (P0): Every stack is observable by default
- Given any log group a stack creates, when it deploys, then it has a retention period, 30 days unless the project sets another, and never keeps logs forever.
- Given any queue a stack creates, when it deploys, then it has a dead-letter queue and an alarm that fires when a message lands there.
- Given any function a stack creates, when it deploys, then alarms exist for its errors and throttles.
- Given an alarm fires, when the message is sent, then it goes to the account's alert address from R2 and names the project and stage.
- Given a resource type with no default alarm, when the diff is shown, then it says so for that resource.

### R16 (P0): One command creates an account for a project
- Given the operator session, when account create runs without confirmation, then it reports the name, email, and access role it would use and changes nothing.
- Given confirmation, then the account exists in the organization within 15 minutes, tagged `managed-by=aws-kit`, and the operator can act in it through `OrganizationAccountAccessRole`.
- Given an account with that name already exists, then the command returns it and creates nothing.
- Given an email another account already uses, then the command refuses before calling AWS.

### R17 (P0): Agents can drive every command
- Given any command, when it finishes, then stdout holds one JSON document with `ok`, and a failure carries a code, a message, and a hint.
- Given the help command, then every command and flag is listed as data, with types, defaults, and descriptions.
- Given a command that changes AWS or files, when it runs without `--yes`, then it changes nothing and reports what it would do.

## Constraints

- AWS has no operation that moves a resource between accounts. A move is a redeploy plus a data copy plus a cutover. R9 exists so the redeploy part is always free.
- Some things cannot move as-is: KMS keys, Cognito user passwords, and globally unique names still held by the old stack, such as S3 bucket names and CloudFront alternate domain names. R9's label has to surface these at first deploy, when choosing differently is cheap.
- A snapshot encrypted with an AWS-managed key cannot be shared with another account. The move step first copies it under a customer-managed key.
- Creating project accounts needs an AWS Organization. A standalone account can create one at any time, and bootstrap does.
- AWS does not let the root user call AssumeRole, so root credentials cannot act inside member accounts. Root is used for bootstrap only.
- Making S3 Block Public Access account-wide cuts off any bucket that is public today. Account readiness checks for public buckets and leaves the setting for a person when it finds one.
- Project stacks are self-contained. They share nothing with other projects except what R2 puts in the account. A shared VPC or database across projects would break R9.
- The everyday session can do anything in the account. R6 and R8 stop a wrong deploy or stack delete. They do not stop an agent from emptying a bucket through the AWS CLI. R12 closes most of that gap for prod.
- When a service is reached from Vercel over the internet, it requires IAM auth and TLS. Verify per service with a test that an unauthenticated connection fails.
- Each Vercel OIDC role trusts one Vercel team and project. Verify with an assertion on the synthesized trust policy.
- The access key now in `~/.aws/credentials` gets deleted in IAM once R1 works. The developer does this step.
- The kit works in any Claude Code session on the developer's machine, because the skill is installed at user level and deploys use that machine's AWS sign-in. Cloud sessions and the claude.ai chat app cannot deploy in the first release.
- Deploy and destroy stay out of the Claude Code allowlist, so each run prompts.
- `aws login` needs AWS CLI 2.32 or later. The installed version is 2.17.42.
- R3, R5, and R10 can only be accepted against real deploys. Use scratch projects and destroy them after.

## Open questions

- Blocks R5: Do Convex functions need to reach AWS resources, or only Next.js server code on Vercel? No OIDC federation from Convex to AWS turned up in research, so Convex access would need a scoped IAM access key, which breaks the last goal.
- Blocks R10: Should the current account become the shared account, or should the shared account be a new, empty one? The current account already holds hand-made resources for older projects. Proposed: the current account becomes the management account and runs no project stacks, and a new `shared` account takes them.
- Blocks no P0 requirement: Does this need to work from cloud or mobile sessions? That needs deploys from CI, which is a non-goal today.

## Decisions

- 2026-10-03: The kit is rules, not a service catalog. A base stack applies tags, prod protection, and the portability checks to every resource of any type. The agent writes ordinary CDK for whatever service is asked for.
- 2026-10-03: CDK in TypeScript. The requirement to move accounts means a project's infrastructure has to exist as account-neutral code, and CloudFormation keeps the state inside the AWS account, so there is no local state file to go stale. CDK reaches every CloudFormation resource type, and a custom resource covers APIs CloudFormation lacks.
- 2026-10-03: One stack per project stage, named `{project}-{stage}`. The target account and region are config values per stage. Projects start in the shared account.
- 2026-10-03: No separate accounts or roles for prod in the first release. The developer does not need permission separation. Protection is keyed on the stage name (R8), and R12 adds an account-wide tag guard that needs no per-project work.
- 2026-10-03: The AWS MCP Server, installed through the `aws-core` plugin, supplies docs, reads, troubleshooting, and scratch experiments across all AWS APIs. Anything kept goes into the stack, because a resource outside a stack cannot be listed, destroyed, or moved by the kit.
- 2026-10-03: The kit is three parts. A small library and CLI in their own repo, a Claude Code skill with the conventions, and an `infra/` CDK app in each project that pins a kit version.
- 2026-10-03: Service-specific choices, such as how Vercel reaches Postgres, are made per project when the service is first added, and recorded in that project's PRD.
- 2026-10-05: Baseline observability is part of the base stack (R15), applied the same way as tags and prod protection. A project that forgets to add alarms still gets them, and the first project to use the kit depends on that.
- 2026-10-03: R6 is enforced in the CLI. Diff records a hash of the synthesized template, and deploy refuses when the current hash differs.
- 2026-11-22: The developer gives the tool the root user, and the tool uses it once. AWS does not let root assume roles, so bootstrap turns the root sign-in into an organization and an operator IAM user, and every other command signs in as the operator with `aws login`. IAM Identity Center was the alternative. It needs a console step to enable and an emailed invite per user, for one developer.
- 2026-11-22: Account creation is a P0 command (R16), not only a step inside a move. Accounts are referred to by name everywhere, and project configs never hold an account ID.
- 2026-11-22: The kit is a Bun CLI whose every command prints one JSON document, and whose help is data (R17). Agents call it from any repo on the machine.
- 2026-11-22: Plan creates a CloudFormation change set without running it, and deploy runs that change set by name. AWS then guarantees what runs is what was shown. The template hash check from 2026-10-03 still applies, so the code in the repo matches what deploys.
- 2026-11-22: Name `aws-kit`, repo `grezxune/aws-kit`, region `us-east-1`. The agent skill lives in the repo at `skill/SKILL.md`. The PRD moved here from the grez-studios `prds/` folder.
- 2026-11-22: Recipes for S3 and CloudFront ship in the first release. The pattern was already written by hand in five earlier projects, which passes the two-projects rule. They follow the developer's storage standard: private buckets, Origin Access Control, bucket policies scoped to one distribution, and HTTPS only.
- 2026-11-22: Budget amount and alert address are machine settings. The budget defaults to $100 a month per account, with email at 50, 80, and 100 percent and at a forecast of 100.
- 2026-11-23: The repo is public under the MIT license. The agent skill is then copied into the developer's public skills repo the same way as other public skills, from one source, and anyone can install the CLI. Examples, tests, and docs name no client or private project, and the first release starts from a single clean commit.
