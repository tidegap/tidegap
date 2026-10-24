import Foundation
import Testing
@testable import TidegapKit

@Suite struct APIClientTests {
    func client(status: Int?) -> (APIClient, FakeServer) {
        let server = FakeServer()
        server.set(port: 47931, status: status)
        return (APIClient(port: 47931, token: "tgc_x", transport: server.transport), server)
    }

    @Test func okDecodesAndSendsBearer() async {
        let (api, server) = client(status: 200)
        let result = await api.summary(since: "2026-10-17T09:00:00.000Z")
        #expect(result.value?.region == "FR")
        #expect(server.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer tgc_x")
        #expect(server.requests.first?.url?.query == "since=2026-10-17T09:00:00.000Z")
    }

    @Test func statusesMapToOutcomes() async {
        #expect(await client(status: nil).0.summary(since: nil) == .offline)
        #expect(await client(status: 401).0.summary(since: nil) == .unpaired)
        #expect(await client(status: 500).0.summary(since: nil) == .error("internal error"))
    }

    @Test func refusedRealConnectionIsOffline() async {
        // Port 1 on loopback: nothing listens, the real URLSession is refused.
        let result = await APIClient(port: 1, token: "tgc_x").summary(since: nil)
        #expect(result == .offline)
    }

    static let item = #"{"task_id":"t 1","title":"x","display_title":"x","status":"scheduled","scheduled_for":"2026-10-17T22:00:00.000Z","not_before":"2026-10-17T22:00:00.000Z","actions":{"cancel":true,"runNow":true,"later":true}}"#

    @Test func postponeSendsPresetWithBearer() async throws {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/tasks/t 1/postpone", status: 200, body: Self.item)
        let result = await api.postpone("t 1", .preset("tonight"))
        #expect(result.value?.notBefore == date("2026-10-17T22:00:00Z"))
        let req = try #require(server.requests.first)
        #expect(req.httpMethod == "POST")
        #expect(req.url?.absoluteString == "http://127.0.0.1:47931/api/tasks/t%201/postpone")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer tgc_x")
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try JSONSerialization.jsonObject(with: try #require(req.httpBody)) as? [String: String]
        #expect(body == ["preset": "tonight"])
    }

    @Test func postponeUntilSendsTheInstant() throws {
        let body = APIClient.postponeBody(.until(date("2026-10-18T07:30:00Z")))
        #expect(String(decoding: body, as: UTF8.self) == #"{"until":"2026-10-18T07:30:00.000Z"}"#)
    }

    @Test func conflictMapsToServerMessage() async {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/tasks/t1/postpone", status: 409, body: #"{"error":"already planned for 23:00"}"#)
        #expect(await api.postpone("t1", .preset("1h")) == .error("already planned for 23:00"))
    }

    @Test func cancelPostsEmptyObjectAndRunNowNoBody() async throws {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/tasks/t1/cancel", status: 200, body: Self.item)
        server.respond(path: "/api/tasks/t1/run-now", status: 200, body: Self.item)
        #expect(await api.cancel("t1").value != nil)
        #expect(await api.runNow("t1").value != nil)
        #expect(server.paths == ["/api/tasks/t1/cancel", "/api/tasks/t1/run-now"])
        let cancel = server.requests[0], run = server.requests[1]
        #expect(cancel.httpMethod == "POST" && run.httpMethod == "POST")
        #expect(cancel.httpBody == Data("{}".utf8))
        #expect(run.httpBody == nil)
        #expect(run.value(forHTTPHeaderField: "Content-Type") == nil)
        #expect(run.value(forHTTPHeaderField: "Authorization") == "Bearer tgc_x")
    }

    @Test func jobsDecodesTheList() async throws {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/jobs", status: 200, body: #"{"jobs":["# + jobFixture + "]}")
        let answer = try #require(await api.jobs().value)
        #expect(answer.supported)
        #expect(answer.jobs.map(\.jobId) == ["job-3f9a1c2e"])
        let req = try #require(server.requests.first)
        #expect(req.httpMethod == "GET")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer tgc_x")
    }

    @Test func jobsOnAnOlderServerIsUnsupportedNotAnError() async {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/jobs", status: 404, body: #"{"error":"not found"}"#)
        #expect(await api.jobs() == .ok(JobsAnswer(jobs: [], supported: false)))
        #expect(await client(status: 401).0.jobs() == .unpaired)
        #expect(await client(status: nil).0.jobs() == .offline)
    }

    @Test func pauseJobPostsNoBodyWithBearer() async throws {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/jobs/job-3f9a1c2e/pause", status: 200, body: jobFixture)
        #expect(await api.pauseJob("job-3f9a1c2e").value?.jobId == "job-3f9a1c2e")
        let req = try #require(server.requests.first)
        #expect(req.httpMethod == "POST")
        #expect(req.url?.absoluteString == "http://127.0.0.1:47931/api/jobs/job-3f9a1c2e/pause")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer tgc_x")
        // The job action routes take no body: the server answers 400 to `{}`.
        #expect(req.value(forHTTPHeaderField: "Content-Type") == nil)
        #expect(req.httpBody == nil)
    }

    @Test func resumeAndRunNowUseTheirRoutes() async {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/jobs/j1/resume", status: 200, body: jobFixture)
        server.respond(path: "/api/jobs/j1/run-now", status: 200, body: jobFixture)
        #expect(await api.resumeJob("j1").value != nil)
        #expect(await api.runJobNow("j1").value != nil)
        #expect(server.paths == ["/api/jobs/j1/resume", "/api/jobs/j1/run-now"])
        #expect(server.requests.allSatisfy { $0.httpMethod == "POST" && $0.httpBody == nil })
    }

    @Test func jobConflictMapsToServerMessage() async {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/jobs/j1/run-now", status: 409, body: #"{"error":"an occurrence is already running"}"#)
        #expect(await api.runJobNow("j1") == .error("an occurrence is already running"))
        server.respond(path: "/api/jobs/j2/pause", status: 404, body: #"{"error":"unknown job"}"#)
        #expect(await api.pauseJob("j2") == .error("unknown job"))
    }

    @Test func jobActionRefusesAnUnsafeId() async {
        let (api, server) = client(status: 200)
        #expect(await api.pauseJob("../tasks/t1") == .error("invalid job id"))
        #expect(server.requests.isEmpty)
    }

    @Test func emptyJobListIsSupported() async {
        let (api, server) = client(status: 200)
        server.respond(path: "/api/jobs", status: 200, body: #"{"jobs":[]}"#)
        #expect(await api.jobs() == .ok(JobsAnswer(jobs: [], supported: true)))
    }
}
