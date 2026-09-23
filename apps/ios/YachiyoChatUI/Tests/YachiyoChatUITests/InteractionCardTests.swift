import UIKit
import XCTest
@testable import YachiyoChatUI

@MainActor
final class InteractionCardTests: XCTestCase {
    func testQuestionRefreshPreservesDraftAndReusedCardClearsIt() throws {
        let card = QuestionCardView()
        let question = QuestionContentPart(id: "first", runId: "run", question: "Choose a destination", choices: [], answer: nil, isWaiting: true)
        card.question = question
        let input = try XCTUnwrap(view("question.input", in: card) as? UITextField)
        var savedDraft: String?
        card.onDraftChange = { savedDraft = $0 }
        input.text = "My unfinished answer"
        input.sendActions(for: .editingChanged)
        XCTAssertEqual(savedDraft, input.text)
        card.question = question
        XCTAssertEqual(input.text, "My unfinished answer")
        var sentAnswer: String?
        card.onAnswer = { sentAnswer = $0 }
        let send = try XCTUnwrap(view("question.send", in: card) as? UIButton)
        send.sendActions(for: .touchUpInside)
        XCTAssertEqual(sentAnswer, "My unfinished answer")
        card.question = QuestionContentPart(id: "second", runId: "run", question: "Next question", choices: [], answer: nil, isWaiting: true)
        XCTAssertEqual(input.text, "")
        XCTAssertFalse(send.isEnabled)
    }

    func testLongChoicesGrowWithoutShrinkingOtherTouchTargets() throws {
        let longChoice = String(repeating: "A longer answer that needs to wrap. ", count: 4)
        let question = QuestionContentPart(id: "question", runId: "run", question: "Choose", choices: [longChoice, "Two", "Three", "Four", "Five"], answer: nil, isWaiting: true)
        let card = QuestionCardView()
        card.question = question
        card.frame = CGRect(x: 0, y: 0, width: 320, height: QuestionCardView.height(for: question, width: 280) + 16)
        card.layoutIfNeeded()
        let longButton = try XCTUnwrap(view("question.choice.\(longChoice)", in: card))
        let shortButton = try XCTUnwrap(view("question.choice.Five", in: card))
        XCTAssertGreaterThan(longButton.bounds.height, 44)
        XCTAssertGreaterThanOrEqual(shortButton.bounds.height, 44)
        let input = try XCTUnwrap(view("question.input", in: card))
        XCTAssertLessThanOrEqual(input.convert(input.bounds, to: card).maxY, card.bounds.height)
    }

    func testPlanActionsStackOnPhoneAndRemainInsideCard() throws {
        let plan = MessageListView.PlanCard(messageId: "plan", content: "Review the proposed changes.", isPending: true)
        let card = PlanCardView()
        card.plan = plan
        card.frame = CGRect(x: 0, y: 0, width: 320, height: PlanCardView.height(for: plan, width: 280) + 16)
        card.layoutIfNeeded()
        let revise = try XCTUnwrap(view("plan.revise", in: card))
        let accept = try XCTUnwrap(view("plan.accept", in: card))
        let handoff = try XCTUnwrap(view("plan.handoff", in: card))
        XCTAssertGreaterThanOrEqual(revise.bounds.height, 44)
        XCTAssertGreaterThan(accept.frame.minY, revise.frame.maxY)
        XCTAssertGreaterThan(handoff.frame.minY, accept.frame.maxY)
        XCTAssertLessThanOrEqual(handoff.convert(handoff.bounds, to: card).maxY, card.bounds.height)
    }

    private func view(_ identifier: String, in root: UIView) -> UIView? {
        if root.accessibilityIdentifier == identifier { return root }
        return root.subviews.lazy.compactMap { self.view(identifier, in: $0) }.first
    }
}
