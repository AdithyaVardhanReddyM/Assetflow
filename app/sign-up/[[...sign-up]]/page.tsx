import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f7f4ee] px-6 py-12">
      <SignUp />
    </div>
  );
}
